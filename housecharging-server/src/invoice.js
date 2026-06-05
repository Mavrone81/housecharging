import { evalFormula } from './formula.js';

// Shape a raw reading row for API responses: drop the (large) payment_proof blob
// and expose payment status + a lightweight hasProof flag. The full proof image is
// fetched on demand via the dedicated /proof endpoints.
export function publicReading(r) {
  const { payment_proof, ...rest } = r;
  return { ...rest, paid: !!r.paid, hasProof: payment_proof != null };
}

// Resolve the effective fee for a house: the per-house override if set (incl. 0),
// otherwise the community default. (`override` is null/undefined/'' when not set.)
const effectiveFee = (override, communityDefault) =>
  (override === null || override === undefined || override === '') ? Number(communityDefault) || 0 : Number(override) || 0;

// Compute charges for a single reading row using the stored rates + formula.
// `settings` is the row from the settings table (numbers may arrive as strings from pg).
// `houseFees` = optional per-house overrides: { garbage, service } (null/'' = inherit).
export function computeInvoice(reading, settings, houseFees = {}) {
  const n = v => Number(v) || 0;
  const r = {
    waterPrev: n(reading.water_prev), waterCurr: n(reading.water_curr),
    gasPrev: n(reading.gas_prev), gasCurr: n(reading.gas_curr),
  };
  const s = {
    waterRate: n(settings.water_rate), waterFixed: n(settings.water_fixed),
    gasRate: n(settings.gas_rate), gasFixed: n(settings.gas_fixed),
    formulaWater: settings.formula_water, formulaGas: settings.formula_gas,
  };
  const waterUsage = r.waterCurr - r.waterPrev;
  const gasUsage = r.gasCurr - r.gasPrev;

  let waterCharge = evalFormula(s.formulaWater, { prev: r.waterPrev, curr: r.waterCurr, rate: s.waterRate, fixed: s.waterFixed });
  let gasCharge = evalFormula(s.formulaGas, { prev: r.gasPrev, curr: r.gasCurr, rate: s.gasRate, fixed: s.gasFixed });
  if (Number.isNaN(waterCharge)) waterCharge = waterUsage * s.waterRate + s.waterFixed;
  if (Number.isNaN(gasCharge)) gasCharge = gasUsage * s.gasRate + s.gasFixed;

  const garbageFee = round2Fee(effectiveFee(houseFees.garbage, settings.garbage_fee));
  const serviceFee = round2Fee(effectiveFee(houseFees.service, settings.service_fee));

  const round2 = x => Math.round(x * 100) / 100;
  waterCharge = round2(waterCharge);
  gasCharge = round2(gasCharge);
  return {
    waterUsage, gasUsage, waterCharge, gasCharge, garbageFee, serviceFee,
    total: round2(waterCharge + gasCharge + garbageFee + serviceFee),
  };
}
const round2Fee = x => Math.round((Number(x) || 0) * 100) / 100;
