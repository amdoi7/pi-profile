// Cloud Code Assist schema normalization. CCA only accepts a legacy
// `parameters` field in an OpenAPI-3 subset; its proto has no fields for
// standard JSON Schema keywords and rejects them with INVALID_ARGUMENT.
// Mirrors the omp fork's normalizeSchemaForCCA. Pure function.

// Keywords CCA's Schema proto has no field for (omp: UNSUPPORTED_SCHEMA_FIELDS +
// CCA_UNSUPPORTED_SCHEMA_FIELDS).
const STRIP_KEYS = new Set([
	"$schema", "$ref", "$defs", "$dynamicRef", "$dynamicAnchor", "$comment",
	"definitions", "examples", "prefixItems", "unevaluatedProperties", "unevaluatedItems",
	"patternProperties", "additionalProperties", "propertyNames", "dependencies",
	"dependentSchemas", "dependentRequired", "deprecated", "readOnly", "writeOnly",
	"minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum",
	"exclusiveMinimum", "exclusiveMaximum", "multipleOf", "pattern", "format",
]);
const SCHEMA_KEYS = new Set(["items", "contains", "propertyNames", "contentSchema", "not", "if", "then", "else"]);
const SCHEMA_LIST_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const SCHEMA_MAP_KEYS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);

export function normalizeForCCA(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(normalizeForCCA);
	if (typeof node !== "object" || node === null) return node;

	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
		if (STRIP_KEYS.has(key)) continue;
		if (SCHEMA_MAP_KEYS.has(key) && typeof value === "object" && value !== null) {
			out[key] = Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalizeForCCA(v)]),
			);
			continue;
		}
		if (SCHEMA_LIST_KEYS.has(key) && Array.isArray(value)) {
			out[key] = value.map(normalizeForCCA);
			continue;
		}
		if (SCHEMA_KEYS.has(key)) {
			out[key] = normalizeForCCA(value);
			continue;
		}
		out[key] = value;
	}

	// type: ["string", "null"] -> { type: "string", nullable: true }
	if (Array.isArray(out.type)) {
		const types = (out.type as unknown[]).filter((t): t is string => typeof t === "string");
		const nonNull = types.filter((t) => t !== "null");
		if (types.includes("null")) out.nullable = true;
		out.type = nonNull[0] ?? types[0];
	}
	return out;
}

/** typebox schemas serialize to plain JSON Schema; strip CCA-hostile fields. */
export function toolParameters(parameters: unknown): Record<string, unknown> {
	return normalizeForCCA(JSON.parse(JSON.stringify(parameters ?? {}))) as Record<string, unknown>;
}
