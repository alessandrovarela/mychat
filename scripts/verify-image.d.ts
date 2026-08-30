export interface ProductionImageInspection {
  forbidden: string[];
  missing: string[];
}

export function inspectProductionImage(
  source: string,
): ProductionImageInspection;
export function verifyProductionImage(path?: string): ProductionImageInspection;
