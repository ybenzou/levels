"""Which symbols are shown on the site and which are pooled to train the model."""

TARGETS = ["AVGO", "SKHY", "CRWV"]

# SKHY (US listing) has only a few months of history; the Korean primary line carries the
# same company's long history and is used as a reference signal on the SKHY page.
PROXY = {"SKHY": "000660.KS"}

# Semiconductor / AI-infrastructure peers pooled for training. More history per regime
# means far more events than any single ticker could provide.
UNIVERSE = TARGETS + [
    "000660.KS", "NVDA", "AMD", "MU", "TSM", "QCOM", "AMAT", "LRCX", "KLAC",
    "MRVL", "ASML", "INTC", "TXN", "ADI", "SMH", "QQQ",
]

DISPLAY_BARS = 252
