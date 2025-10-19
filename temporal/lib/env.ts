export type TemporalEnv = {
  temporalAddress: string;
  traderQueue: string;
  openaiQueue: string;
  binanceQueue: string;
};

export function loadEnv(): TemporalEnv {
  const temporalAddress = process.env.TEMPORAL_ADDRESS;
  const traderQueue = process.env.TASK_QUEUE; // orchestrator workflows
  const openaiQueue = process.env.TASK_QUEUE_OPENAI;
  const binanceQueue = process.env.TASK_QUEUE_BINANCE;
  const namespace = String(process.env.TEMPORAL_NAMESPACE || '');
  const side = String(process.env.TRADE_SIDE || '').toUpperCase();
  
  if (side !== 'SHORT') {
    throw new Error('TRADE_SIDE must be SHORT in this instance');
  }

  if (!temporalAddress) {
    throw new Error('TEMPORAL_ADDRESS is required (format: HOST:PORT, e.g. 127.0.0.1:7500)');
  }
  
  // CRITICAL: Validate TEMPORAL_ADDRESS format (host:port)
  const addressMatch = temporalAddress.match(/^([^:]+):(\d+)$/);
  if (!addressMatch) {
    throw new Error(`TEMPORAL_ADDRESS must be in format HOST:PORT (got: ${temporalAddress})`);
  }
  const host = addressMatch[1];
  const port = parseInt(addressMatch[2], 10);
  
  // Validate port range (avoid privileged ports <1024)
  if (port < 1024 || port > 65535) {
    throw new Error(`TEMPORAL_ADDRESS port must be in range 1024-65535 (got: ${port})`);
  }

  // CRITICAL: Forbidden ports policy (prevents accidental connection to LONG instance)
  const forbiddenPorts = process.env.FORBIDDEN_TEMPORAL_PORTS;
  if (forbiddenPorts) {
    const forbidden = forbiddenPorts.split(',').map(p => p.trim()).filter(Boolean);
    if (forbidden.includes(String(port))) {
      throw new Error(`TEMPORAL_ADDRESS port ${port} is FORBIDDEN for SHORT instance (FORBIDDEN_TEMPORAL_PORTS: ${forbiddenPorts}). Use a different port!`);
    }
  }

  // CRITICAL: Allowed hosts policy (optional whitelist)
  const allowedHosts = process.env.ALLOWED_TEMPORAL_HOSTS;
  if (allowedHosts) {
    const allowed = allowedHosts.split(',').map(h => h.trim()).filter(Boolean);
    if (!allowed.includes(host)) {
      throw new Error(`TEMPORAL_ADDRESS host "${host}" is NOT in allowed list (ALLOWED_TEMPORAL_HOSTS: ${allowedHosts})`);
    }
  }

  // CRITICAL: Namespace must be trader-short for SHORT instance
  if (!namespace) {
    throw new Error('TEMPORAL_NAMESPACE is required for SHORT instance (must be: trader-short)');
  }
  if (namespace !== 'trader-short') {
    throw new Error(`TEMPORAL_NAMESPACE must be "trader-short" for SHORT instance (got: ${namespace})`);
  }

  if (!traderQueue) {
    throw new Error('TASK_QUEUE is required for orchestrators (e.g. entry-short)');
  }
  if (!openaiQueue) {
    throw new Error('TASK_QUEUE_OPENAI is required (e.g. io-openai-short)');
  }
  if (!binanceQueue) {
    throw new Error('TASK_QUEUE_BINANCE is required (e.g. io-binance-short)');
  }

  // Enforce -short suffix on queues and namespace
  const endsWithShort = (v?: string) => typeof v === 'string' && /-short$/i.test(v);
  if (!endsWithShort(traderQueue)) throw new Error('TASK_QUEUE must end with -short');
  if (!endsWithShort(openaiQueue)) throw new Error('TASK_QUEUE_OPENAI must end with -short');
  if (!endsWithShort(binanceQueue)) throw new Error('TASK_QUEUE_BINANCE must end with -short');
  if (!endsWithShort(namespace)) throw new Error('TEMPORAL_NAMESPACE must end with -short');
  
  // CRITICAL: Never allow -long in queue names (prevents cross-contamination)
  const hasLong = (v?: string) => typeof v === 'string' && /-long/i.test(v);
  if (hasLong(traderQueue)) throw new Error('TASK_QUEUE contains "-long" - this is SHORT instance!');
  if (hasLong(openaiQueue)) throw new Error('TASK_QUEUE_OPENAI contains "-long" - this is SHORT instance!');
  if (hasLong(binanceQueue)) throw new Error('TASK_QUEUE_BINANCE contains "-long" - this is SHORT instance!');
  if (hasLong(namespace)) throw new Error('TEMPORAL_NAMESPACE contains "-long" - this is SHORT instance!');

  return { temporalAddress, traderQueue, openaiQueue, binanceQueue };
}


