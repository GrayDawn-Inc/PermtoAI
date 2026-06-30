import type { RecommendedControl } from "../schemas/index.js";

export interface NormalizedControl {
  name: string;
  reductionPercent: number;
  approved: boolean;
}

const GENERIC_CONTROL_REDUCTION_PERCENT = 10;

export function normalizeControl(control: RecommendedControl): NormalizedControl {
  if (typeof control === "string") {
    return {
      name: control,
      reductionPercent: GENERIC_CONTROL_REDUCTION_PERCENT,
      approved: false,
    };
  }

  return {
    name: control.name,
    reductionPercent: control.reductionPercent,
    approved: control.approved ?? false,
  };
}

export function normalizeControls(controls: RecommendedControl[]): NormalizedControl[] {
  return controls.map(normalizeControl);
}

export function formatControl(control: RecommendedControl): string {
  const normalized = normalizeControl(control);
  const status = normalized.approved ? "approved" : "pending";
  return `${normalized.name} (${normalized.reductionPercent}% reduction, ${status})`;
}

export function formatControls(controls: RecommendedControl[]): string {
  return controls.map(formatControl).join("; ");
}

export function controlName(control: RecommendedControl): string {
  return normalizeControl(control).name;
}
