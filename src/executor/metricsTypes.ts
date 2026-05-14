export type LiquidationOutcome = "confirmed" | "failed" | "rejected";

export type RejectReason =
  | "insufficient_funds"
  | "gas_price_too_low"
  | "intrinsic_gas"
  | "submit_timeout"
  | "margin_safe_at_estimate"
  | "price_feed_unavailable"
  | "rpc_error"
  | "other";

export type FailReason =
  | "tx_dropped"
  | "wait_timeout"
  | "wait_other"
  | "margin_safe_at_mine"
  | "already_liquidated"
  | "market_closed"
  | "oracle_stale"
  | "other_revert";

export type FundingFailureReason = "treasury_insufficient" | "treasury_partial" | "transfer_reverted" | "other";

export type Reason = "ok" | RejectReason | FailReason;
