export function readResponsesJson(res: any): string {
	const t = (res?.output_text ?? '').trim();
	if (t) return t;

	function tryFromContent(parts: any[]): string | null {
		let buf = '';
		for (const p of parts) {
			const content = Array.isArray(p?.content) ? p.content : [];
			for (const c of content) {
				if ((c?.type === 'output_text' || c?.type === 'text') && typeof c?.text === 'string') {
					buf += c.text;
				} else if (c?.type === 'input_text' && typeof c?.text === 'string') {
					buf = c.text;
				} else if ((c?.type === 'output_json' || c?.type === 'json' || c?.type === 'json_schema') && c?.json) {
					try { return JSON.stringify(c.json); } catch {}
				}
			}
		}
		buf = (buf ?? '').trim();
		return buf || null;
	}

	const parts = Array.isArray(res?.output) ? res.output : [];
	const fromParts = tryFromContent(parts);
	if (fromParts) return fromParts;

	// Deep fallback: search any { json: ... } or plausible text in the whole response
	try {
		const stack: any[] = [res];
		while (stack.length) {
			const node = stack.pop();
			if (!node) continue;
			if (node && typeof node === 'object') {
				if (node.json && typeof node.json === 'object') {
					return JSON.stringify(node.json);
				}
				if (typeof node.text === 'string') {
					const txt = node.text.trim();
					if (txt.startsWith('{') || txt.startsWith('[')) return txt;
				}
				for (const k of Object.keys(node)) {
					const v: any = (node as any)[k];
					if (v && (typeof v === 'object' || Array.isArray(v))) stack.push(v);
				}
			} else if (Array.isArray(node)) {
				for (const v of node) stack.push(v);
			}
		}
	} catch {}

	throw new Error('empty_output_text');
}
