-- Opt-in for new installs; existing merchant choices are preserved.
ALTER TABLE "Shop" ALTER COLUMN "leadCapture" SET DEFAULT 'off';
