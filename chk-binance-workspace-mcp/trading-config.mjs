// One ceiling feeds the workspace, tool schemas, splitting and runtime validation.
// The hard upper bound matches the database/Android authorization ceiling.
const configured = Number(process.env.BYBIT_MAX_ORDER_USDC || 30);
export const MAX_ORDER_USDC = Number.isFinite(configured) && configured > 1 ? Math.min(30, configured) : 30;
export const MAX_BATCH_ORDERS = 20;
export const CATALOG_VERSION = '18.0.0';
export const orderLinkId = id => `chk-${String(id).replaceAll('-', '').slice(0,28)}`;
