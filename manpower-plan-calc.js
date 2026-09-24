/* ============================================================
 * HireGrid — Manpower Plan salary & cost calculation engine
 * BRD §5.1.5 (Salary & Total Cost Calculation Logic)
 *
 * Dependency-free plain JS so it can be:
 *   1. loaded directly by manpower-plan.html for the live cost
 *      preview, and
 *   2. required() directly by the Playwright test suite (test_mp_v2.js)
 *      to unit-test the math without needing the whole page/DOM.
 *
 * Exposed as window.MPCalc in a browser, module.exports in Node.
 * ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof window !== 'undefined') {
    window.MPCalc = api;
  }
})(this, function () {
  'use strict';

  /* ---------- Step 2: Egypt progressive tax brackets ----------
   * Each row is copied LITERALLY from the BRD table — note the
   * "subtract" value is NOT always the row's lower bound (see the
   * 600k/700k/800k/900k rows, which all subtract 400,000 as part of
   * the 2026 rebate phase-out band). Do not "simplify" this array —
   * it must match the statutory table's own numbers exactly.
   * Stored for real use in the `statutory_parameters` table
   * (params.brackets) — this copy is only the fallback default used
   * if the DB table hasn't loaded yet, or by the unit tests.
   */
  function defaultEgyptBrackets() {
    return [
      { upTo: 40000, subtract: 0, rate: 0, add: 0 },
      { upTo: 55000, subtract: 40000, rate: 0.10, add: 0 },
      { upTo: 70000, subtract: 55000, rate: 0.15, add: 1500 },
      { upTo: 200000, subtract: 70000, rate: 0.20, add: 3750 },
      { upTo: 400000, subtract: 200000, rate: 0.225, add: 29750 },
      { upTo: 600000, subtract: 400000, rate: 0.25, add: 74750 },
      { upTo: 700000, subtract: 400000, rate: 0.25, add: 78750 },
      { upTo: 800000, subtract: 400000, rate: 0.25, add: 81500 },
      { upTo: 900000, subtract: 400000, rate: 0.25, add: 85000 },
      { upTo: 1200000, subtract: 400000, rate: 0.25, add: 90000 },
      { upTo: null, subtract: 1200000, rate: 0.275, add: 300000 }
    ];
  }

  function defaultStatutoryParams() {
    return {
      country: 'EG',
      year: new Date().getFullYear(),
      sis_min: 2300,
      sis_max: 16700,
      employee_si_rate: 0.11,
      company_si_rate: 0.1875,
      personal_exemption_annual: 20100,
      support_allowance_rate: 0.15,
      brackets: defaultEgyptBrackets()
    };
  }

  // Annual progressive tax for a given Annual Taxable Income (L),
  // walking the bracket table top-down and stopping at the first row
  // whose upper bound covers L (BRD §5.1.5 Step 2).
  function egyptAnnualTax(L, brackets) {
    if (!(L > 0)) return 0;
    const rows = brackets && brackets.length ? brackets : defaultEgyptBrackets();
    for (const b of rows) {
      const upTo = (b.upTo === null || b.upTo === undefined) ? Infinity : b.upTo;
      if (L <= upTo) {
        return Math.max(0, (L - b.subtract) * b.rate + b.add);
      }
    }
    // Should never fall through (last row's upTo is null/Infinity), but
    // be defensive rather than silently returning undefined.
    const last = rows[rows.length - 1];
    return Math.max(0, (L - last.subtract) * last.rate + last.add);
  }

  /* ---------- Step 1: iterative net-to-gross conversion (EGP only) ----------
   * Egyptian income tax is progressive, so there's no closed-form
   * inverse from "Net Basic Monthly Salary" back to "Gross Basic
   * Salary" — we bisection-search for the Gross Basic Salary that,
   * once run back through Steps 1-6, reproduces the net salary the
   * user typed, to within 1 EGP (BRD explicitly allows bisection).
   */
  function netFromGrossBasic(grossBasic, opts) {
    const transportationAllowance = opts.transportationAllowance || 0;
    const mobileAllowance = opts.mobileAllowance || 0;
    const grossTotalPackage = grossBasic + transportationAllowance + mobileAllowance;
    const sis = Math.min(Math.max(grossTotalPackage, opts.sisMin), opts.sisMax);
    const employeeSiMonthly = sis * opts.employeeSiRate;
    const annualTaxableIncome = Math.max(0, (grossTotalPackage * 12) - (employeeSiMonthly * 12) - opts.personalExemptionAnnual);
    const annualTax = egyptAnnualTax(annualTaxableIncome, opts.brackets);
    const monthlyTax = annualTax / 12;
    const netSalary = grossTotalPackage - employeeSiMonthly - monthlyTax;
    return { netSalary, grossTotalPackage, sis, employeeSiMonthly, annualTaxableIncome, annualTax, monthlyTax };
  }

  function egyptGrossUp(netTarget, opts) {
    let lo = netTarget * 0.5; // safety margin below target — allowances can make net exceed the naive lower bound in edge cases
    let hi = Math.max(netTarget * 3, netTarget + 50000);
    let mid = netTarget, result = null;
    for (let i = 0; i < 100; i++) {
      mid = (lo + hi) / 2;
      result = netFromGrossBasic(mid, opts);
      const diff = result.netSalary - netTarget;
      if (Math.abs(diff) < 1) break; // converge within 1 EGP, as the BRD requires
      if (diff < 0) lo = mid; else hi = mid;
    }
    return Object.assign({ grossBasicSalary: mid }, result);
  }

  const VARIABLE_RATIO_MAP = {
    none: 0,
    '10_90': 10 / 90,
    '20_80': 20 / 80,
    '30_70': 30 / 70,
    '40_60': 40 / 60
  };

  /* ---------- Remaining months (proration) ----------
   * "Number of calendar months from Position Target Start Date's
   * month through December of that year, inclusive." July -> 6,
   * January -> 12.
   */
  function remainingMonthsFromStartDate(dateStr) {
    if (!dateStr) return 12;
    const d = new Date(dateStr + (String(dateStr).length <= 10 ? 'T00:00:00' : ''));
    if (isNaN(d.getTime())) return 12;
    return 12 - d.getMonth();
  }

  /* ---------- Step 3: EGP monthly cost components + Total Current Year Cost ----------
   * `position` is a row from the `positions` master table (policy
   * columns from §5.1.5). `statutoryParams` is a row from
   * `statutory_parameters` (year+country versioned, admin editable).
   * CONFIRMED (A-01): Gross Variable Salary is computed from the
   * POST-gross-up Gross Basic Salary and added as a pure gross cost
   * line — it never feeds back into SIS/tax (kept outside Step 1).
   */
  function computeEgyptCost(input) {
    const position = input.position || {};
    const p = Object.assign({}, defaultStatutoryParams(), input.statutoryParams || {});
    const grossIncentive = Number(input.grossIncentive) || 0;
    const remainingMonths = input.remainingMonths != null ? input.remainingMonths : remainingMonthsFromStartDate(input.positionTargetStartDate);

    const hasMobileLine = !!position.has_mobile_line_instead;
    const mobileAllowanceForGrossUp = hasMobileLine ? 0 : (Number(position.mobile_allowance) || 0);

    const grossUp = egyptGrossUp(Number(input.netBasicMonthlySalary) || 0, {
      sisMin: p.sis_min,
      sisMax: p.sis_max,
      employeeSiRate: p.employee_si_rate,
      personalExemptionAnnual: p.personal_exemption_annual,
      brackets: p.brackets,
      transportationAllowance: Number(position.transportation_allowance) || 0,
      mobileAllowance: mobileAllowanceForGrossUp
    });

    const grossBasicSalary = grossUp.grossBasicSalary;
    const ratio = VARIABLE_RATIO_MAP.hasOwnProperty(position.variable_salary_ratio) ? VARIABLE_RATIO_MAP[position.variable_salary_ratio] : 0;
    const grossVariableSalary = (position.variable_salary_ratio && position.variable_salary_ratio !== 'none') ? grossBasicSalary * ratio : 0;

    const transportation = Number(position.transportation_allowance) || 0;
    const mobileAllowance = mobileAllowanceForGrossUp;
    const mobileLineCost = hasMobileLine ? (Number(position.mobile_line_company_cost) || 0) : 0;
    const supportAllowance = position.has_support_allowance ? grossBasicSalary * (p.support_allowance_rate || 0.15) : 0;
    const companySiShare = grossUp.sis * (p.company_si_rate);
    const medicalInsuranceCompanyShare = Number(position.medical_insurance_monthly) || 0;

    const totalMonthlyCost = grossBasicSalary + grossVariableSalary + grossIncentive + transportation
      + mobileAllowance + mobileLineCost + supportAllowance + companySiShare + medicalInsuranceCompanyShare;

    const lifeInsuranceAnnual = Number(position.life_insurance_annual) || 0;
    const laptopCostAnnual = Number(position.laptop_cost_annual) || 0;
    const overheadCapexAnnual = Number(position.overhead_capex_annual) || 0;
    const trainingAnnual = Number(position.training_annual) || 0;
    const yearlyOnlyTotal = lifeInsuranceAnnual + laptopCostAnnual + overheadCapexAnnual + trainingAnnual;

    const totalCurrentYearCost = (totalMonthlyCost * remainingMonths) + (yearlyOnlyTotal * remainingMonths / 12);

    return {
      currency: 'EGP',
      netBasicMonthlySalary: Number(input.netBasicMonthlySalary) || 0,
      grossBasicSalary,
      grossTotalPackage: grossUp.grossTotalPackage,
      socialInsuranceSalary: grossUp.sis,
      employeeSiShareMonthly: grossUp.employeeSiMonthly,
      annualTaxableIncome: grossUp.annualTaxableIncome,
      annualTax: grossUp.annualTax,
      monthlyTax: grossUp.monthlyTax,
      grossVariableSalary,
      grossIncentive,
      transportationAllowance: transportation,
      mobileAllowance,
      mobileLineCompanyCost: mobileLineCost,
      supportAllowance,
      companySiShareMonthly: companySiShare,
      medicalInsuranceCompanyShare,
      lifeInsuranceAnnual,
      laptopCostAnnual,
      overheadCapexAnnual,
      trainingAnnual,
      remainingMonths,
      totalMonthlyCost,
      totalCurrentYearCost
    };
  }

  /* ---------- Step 4: UAE / KSA — no income tax, no gross-up ----------
   * Net Basic Monthly Salary = Gross Basic Monthly Salary directly
   * (BR-17). Simplified per the BRD's own "don't over-build every
   * line item" guidance for the 3-year-amortized UAE items and the
   * one-time onboarding costs — those roll into a single admin-
   * editable `other_current_year_cost_yearly` policy field on
   * `positions` (documented in the migration + final report).
   */
  function computeGulfCost(input) {
    const position = input.position || {};
    const country = input.country; // 'UAE' | 'KSA'
    const remainingMonths = input.remainingMonths != null ? input.remainingMonths : remainingMonthsFromStartDate(input.positionTargetStartDate);

    const basic = Number(input.netBasicMonthlySalary) || 0; // no gross-up per BR-17
    const housing = Number(position.housing_allowance) || 0;
    const hasMobileLine = !!position.has_mobile_line_instead;
    const mobileAllowance = hasMobileLine ? 0 : (Number(position.mobile_allowance) || 0);
    const mobileLineCost = hasMobileLine ? (Number(position.mobile_line_company_cost) || 0) : 0;
    const transportation = Number(position.transportation_allowance) || 0;
    const ratio = VARIABLE_RATIO_MAP.hasOwnProperty(position.variable_salary_ratio) ? VARIABLE_RATIO_MAP[position.variable_salary_ratio] : 0;
    const variable = (position.variable_salary_ratio && position.variable_salary_ratio !== 'none') ? basic * ratio : 0;
    const grossIncentive = Number(input.grossIncentive) || 0;

    let gosi = 0, saudization = 0;
    if (country === 'KSA') {
      gosi = 0.02 * (basic + housing); // employer-only GOSI share, monthly
      saudization = Number(position.gosi_saudization_flat) || 0;
    }

    const totalMonthlyCost = basic + housing + mobileAllowance + mobileLineCost + transportation + variable + grossIncentive + gosi + saudization;

    // Yearly-equivalent items folded into Total Current Year Cost via the
    // same "× remainingMonths ÷ 12" proration as the annual EGP items.
    const medicalInsuranceAnnual = Number(position.medical_insurance_monthly) || 0; // treated as an annual figure for Gulf per policy config
    const flightTicketsAnnual = (Number(position.flight_tickets_biannual) || 0) * 2; // "2x/year"
    let simplifiedOtherAnnual = 0;
    if (country === 'KSA') {
      simplifiedOtherAnnual += Number(position.iqama_fees_annual) || 0;
    }
    if (country === 'UAE') {
      // 3-year-amortized items, simplified to /3 per year as documented above.
      simplifiedOtherAnnual += ((Number(position.evisa_cost_3yr) || 0)
        + (Number(position.medical_exam_cost_3yr) || 0)
        + (Number(position.change_of_status_cost_3yr) || 0)
        + (Number(position.contract_fees_3yr) || 0)
        + (Number(position.employment_letter_cost_3yr) || 0)
        + (Number(position.bank_account_opening_cost_3yr) || 0)) / 3;
    }
    simplifiedOtherAnnual += Number(position.other_current_year_cost_yearly) || 0;

    const yearlyOnlyTotal = medicalInsuranceAnnual + flightTicketsAnnual + simplifiedOtherAnnual;
    const totalCurrentYearCost = (totalMonthlyCost * remainingMonths) + (yearlyOnlyTotal * remainingMonths / 12);

    // One-time onboarding costs (Transfer Fees/Visa Quota/Hotel/Laptop) are
    // informational only and explicitly excluded from Total Current Year Cost.
    const onboardingOneTimeCost = Number(position.onboarding_one_time_cost) || 0;

    return {
      currency: country === 'KSA' ? 'SAR' : 'AED',
      netBasicMonthlySalary: basic,
      basicSalary: basic,
      housingAllowance: housing,
      mobileAllowance,
      mobileLineCompanyCost: mobileLineCost,
      transportationAllowance: transportation,
      variableSalary: variable,
      grossIncentive,
      gosiCompanyShareMonthly: gosi,
      saudizationFlatMonthly: saudization,
      medicalInsuranceAnnual,
      flightTicketsAnnual,
      simplifiedOtherAnnual,
      remainingMonths,
      totalMonthlyCost,
      totalCurrentYearCost,
      onboardingOneTimeCost
    };
  }

  // Top-level dispatch: picks the calc path by currency (derived from
  // the selected Branch's country — EG -> EGP, UAE -> AED, KSA -> SAR).
  function calculateCost(input) {
    const currency = input.currency;
    if (currency === 'EGP') {
      return computeEgyptCost(input);
    }
    const country = currency === 'SAR' ? 'KSA' : 'UAE';
    return computeGulfCost(Object.assign({}, input, { country }));
  }

  function currencyForCountry(country) {
    return { EG: 'EGP', UAE: 'AED', KSA: 'SAR' }[country] || 'EGP';
  }

  /* ---------- Approval chain (BRD §5.1.4 Status / §5.1.6 BR-15a) ----------
   * Same 4 possible steps every time, minus whichever role initiated
   * the line, always ending with Top Management. Genuinely generic —
   * works for all 3 initiation paths in §5.1.2 from one rule.
   */
  const APPROVAL_STEPS = [
    { role: 'recruiter', label: 'Recruiter Review' },
    { role: 'bu_head', label: 'Hiring Manager Approval' },
    { role: 'head_of_hr', label: 'Head of HR Approval' },
    { role: 'top_management', label: 'Top Management Approval' }
  ];

  function buildApprovalChain(initiatorRole) {
    return APPROVAL_STEPS.filter(function (step) { return step.role !== initiatorRole; });
  }

  function statusLabelForStep(chain, currentStep, terminalStatus) {
    if (terminalStatus) return terminalStatus;
    if (!chain || currentStep >= chain.length) return 'Approved';
    const step = chain[currentStep];
    const labels = {
      recruiter: 'Pending Recruiter Review',
      bu_head: 'Pending Hiring Manager Approval',
      head_of_hr: 'Pending Head of HR Approval',
      top_management: 'Pending Top Management Approval'
    };
    return labels[step.role] || ('Pending ' + step.label);
  }

  // BR-15a: a stakeholder can never approve/reject/return their own
  // submission, even if they hold multiple roles, and never act twice
  // on the same line under a different hat. Checked BOTH when building
  // the chain (a role never appears twice: filtered above) and here,
  // right before any approve/reject/return action, against who
  // actually submitted the line and who has already acted on it.
  function isSelfApprovalBlocked(actorId, mpRow) {
    if (!actorId) return true;
    if (mpRow.submitted_by && mpRow.submitted_by === actorId) return true;
    if (mpRow.requested_by && mpRow.requested_by === actorId) return true;
    const log = mpRow.approval_log_entries || mpRow._approval_log || [];
    if (Array.isArray(log)) {
      return log.some(function (a) { return a.actor_id === actorId; });
    }
    return false;
  }

  // BR-09a: Return-for-Revision goes back exactly one step.
  function stepAfterReturn(currentStep) {
    return Math.max(0, currentStep - 1);
  }

  function formatPositionId(year, divisionAbbreviation, serial) {
    return 'MP_' + year + '_' + divisionAbbreviation + '_' + serial;
  }

  return {
    defaultEgyptBrackets: defaultEgyptBrackets,
    defaultStatutoryParams: defaultStatutoryParams,
    egyptAnnualTax: egyptAnnualTax,
    egyptGrossUp: egyptGrossUp,
    remainingMonthsFromStartDate: remainingMonthsFromStartDate,
    computeEgyptCost: computeEgyptCost,
    computeGulfCost: computeGulfCost,
    calculateCost: calculateCost,
    currencyForCountry: currencyForCountry,
    VARIABLE_RATIO_MAP: VARIABLE_RATIO_MAP,
    APPROVAL_STEPS: APPROVAL_STEPS,
    buildApprovalChain: buildApprovalChain,
    statusLabelForStep: statusLabelForStep,
    isSelfApprovalBlocked: isSelfApprovalBlocked,
    stepAfterReturn: stepAfterReturn,
    formatPositionId: formatPositionId
  };
});
