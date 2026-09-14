import { HttpError } from '../errors';

export function parseFields(
  value: unknown,
  allowedFields: ReadonlyArray<string>,
): string[] | null {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_FIELDS', 'fields must be a comma-separated string');
  }
  if (typeof value !== 'string') {
    throw new HttpError(400, 'INVALID_FIELDS', 'fields must be a comma-separated string');
  }

  const allowed = new Set(allowedFields);
  const fields = value
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);
  const invalid = fields.filter((field) => !allowed.has(field));
  if (invalid.length > 0) {
    throw new HttpError(400, 'INVALID_FIELDS', 'Unsupported fields requested', {
      invalid,
      allowed: allowedFields,
    });
  }
  return [...new Set(fields)];
}

export function pickFields(
  value: Record<string, unknown>,
  fields: ReadonlyArray<string> | null,
): Record<string, unknown> {
  if (!fields) return value;
  const selected: Record<string, unknown> = {};
  for (const field of fields) {
    selected[field] = value[field];
  }
  return selected;
}

export type RelationConfig = unknown;

export function buildSelect(
  fields: string[],
  scalarFields: Set<string>,
  relationMap: Record<string, RelationConfig>,
): Record<string, unknown> {
  const select: Record<string, unknown> = {};
  for (const field of fields) {
    if (scalarFields.has(field)) {
      select[field] = true;
    } else if (field in relationMap) {
      select[field] = relationMap[field];
    }
  }
  return select;
}
