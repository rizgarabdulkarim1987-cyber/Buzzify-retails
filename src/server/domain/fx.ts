// Dollar to dinar money conversion. Pure: no db, no clock.
// Rate = IQD per 1 USD x 10^6 ("micro"); amounts are minor units (USD cents, whole dinars).
const CENT_MICRO = 100_000_000n; // 10^2 (cents) x 10^6 (micro)

/** Dinar credited for USD cents at a rate, rounded down to a whole dinar. */
export function usdToDinar(usdCents: bigint, rateMicro: bigint): bigint {
  return (usdCents * rateMicro) / CENT_MICRO;
}

/** Smallest USD cents whose dinar value is at least `dinar`, so exact dollars always cover the due. */
export function dinarToUsdCentsCeil(dinar: bigint, rateMicro: bigint): bigint {
  if (dinar <= 0n) return 0n;
  return (dinar * CENT_MICRO + rateMicro - 1n) / rateMicro;
}

/** A believable shift rate: 100 to 10,000 IQD per USD. */
export function validRateMicro(r: bigint): boolean {
  return r >= 100_000_000n && r <= 10_000_000_000n;
}
