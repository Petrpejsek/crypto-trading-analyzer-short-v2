export function cleanSchema<T extends Record<string, unknown>>(s: T) {
	const { $schema, title, version, ...rest } = s as any;
	return rest;
}
