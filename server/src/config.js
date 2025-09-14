// Centralized knobs (no behavior change)
export const PAGES = Number(process.env.PAGES || 1);
export const DAYS = Number(process.env.DAYS || 30);

export const DEFAULT_MIN_BUY_USD = Number(process.env.MIN_BUY_USD || 500000); // $500k
export const USER_AGENT = process.env.USER_AGENT || 'Mozilla/5.0';

export const CLUSTER_WINDOW_DAYS    = Number(process.env.CLUSTER_WINDOW_DAYS    || 7);
export const CLUSTER_MIN_INSIDERS   = Number(process.env.CLUSTER_MIN_INSIDERS   || 2);
export const CLUSTER_MIN_TOTAL_USD  = Number(process.env.CLUSTER_MIN_TOTAL_USD  || 500000);

export const DEBUG = !!process.env.DEBUG_SCRAPE;
