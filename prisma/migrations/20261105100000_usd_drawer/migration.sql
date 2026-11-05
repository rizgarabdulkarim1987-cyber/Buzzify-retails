-- AlterTable
ALTER TABLE "RtShift" ADD COLUMN     "countedUsdMinor" BIGINT,
ADD COLUMN     "differenceUsdMinor" BIGINT,
ADD COLUMN     "expectedUsdMinor" BIGINT,
ADD COLUMN     "openingUsdMinor" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "usdRateMicro" BIGINT;

-- AlterTable
ALTER TABLE "RtPayment" ADD COLUMN     "rateMicro" BIGINT,
ADD COLUMN     "tenderedCurrency" "Currency",
ADD COLUMN     "tenderedForeignMinor" BIGINT;

-- Hand-written constraints.
ALTER TABLE "RtShift"
    ADD CONSTRAINT "RtShift_usd_rate_positive" CHECK ("usdRateMicro" IS NULL OR "usdRateMicro" > 0),
    ADD CONSTRAINT "RtShift_usd_opening_nonneg" CHECK ("openingUsdMinor" >= 0),
    ADD CONSTRAINT "RtShift_usd_counted_nonneg" CHECK ("countedUsdMinor" IS NULL OR "countedUsdMinor" >= 0),
    -- All three closing fields are null or all set, and an OPEN shift has none.
    ADD CONSTRAINT "RtShift_usd_closed_fields" CHECK (
        ("countedUsdMinor" IS NULL) = ("expectedUsdMinor" IS NULL)
        AND ("countedUsdMinor" IS NULL) = ("differenceUsdMinor" IS NULL)
        AND ("status" = 'CLOSED' OR "countedUsdMinor" IS NULL)
    ),
    ADD CONSTRAINT "RtShift_usd_difference" CHECK ("countedUsdMinor" IS NULL OR "differenceUsdMinor" = "countedUsdMinor" - "expectedUsdMinor");

ALTER TABLE "RtPayment"
    ADD CONSTRAINT "RtPayment_foreign_together" CHECK (
        ("tenderedForeignMinor" IS NULL) = ("rateMicro" IS NULL)
        AND ("tenderedForeignMinor" IS NULL) = ("tenderedCurrency" IS NULL)
    ),
    ADD CONSTRAINT "RtPayment_foreign_positive" CHECK (
        ("rateMicro" IS NULL OR "rateMicro" > 0) AND ("tenderedForeignMinor" IS NULL OR "tenderedForeignMinor" > 0)
    ),
    ADD CONSTRAINT "RtPayment_card_no_foreign" CHECK ("method" <> 'CARD' OR "tenderedForeignMinor" IS NULL);
