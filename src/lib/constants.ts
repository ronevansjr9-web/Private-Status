// Client-safe constants (no node imports — importable from route components).
export const CUSTOM_FEE_CENTS = 1500; // flat custom-order fee, USD

// Base garment prices used in the custom-order payment amount math
// (base + flat fee = the combined custom Stripe link's price). Store settings
// may override these via customTeeBaseCents / customHoodieBaseCents.
export const CUSTOM_TEE_BASE_CENTS = 2800;
export const CUSTOM_HOODIE_BASE_CENTS = 4800;
