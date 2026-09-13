import express from "express";

const app = express();
app.use(express.static("."));

const PORT = process.env.PORT || 3000;
const PSXI_TOKEN = process.env.PSXI_TOKEN;

const MARKET_URL = "https://www.psxi.gg/api/v1/market/horizonxi";
const CRAFT_ITEM_URL = (itemId) =>
  `https://www.psxi.gg/api/v1/craft/horizonxi/item/${itemId}`;

let marketCache = null;
let marketCacheTime = 0;

const MARKET_CACHE_MS = 5 * 60 * 1000;

function headers() {
  return {
    accept: "application/json",
    "user-agent": "HorizonXI-Profit-Scanner/1.0",
    Authorization: `Bearer ${PSXI_TOKEN}`
  };
}

async function psxiFetch(url) {
  if (!PSXI_TOKEN) {
    throw new Error("PSXI_TOKEN is not configured");
  }

  const r = await fetch(url, {
    headers: headers()
  });

  const text = await r.text();

  if (!r.ok) {
    throw new Error(`PSXI ${r.status}: ${text.slice(0, 300)}`);
  }

  return JSON.parse(text);
}

async function getMarket() {
  const now = Date.now();

  if (
    marketCache &&
    now - marketCacheTime < MARKET_CACHE_MS
  ) {
    return marketCache;
  }

  marketCache = await psxiFetch(MARKET_URL);
  marketCacheTime = now;

  return marketCache;
}

function getMarketItems(market) {
  if (Array.isArray(market)) return market;
  if (Array.isArray(market.data)) return market.data;
  if (Array.isArray(market.items)) return market.items;
  return [];
}

function findItem(items, query) {
  const q = String(query || "").trim().toLowerCase();

  if (!q) return null;

  return (
    items.find(
      (x) =>
        String(x.itemName || "")
          .trim()
          .toLowerCase() === q
    ) ||
    items.find((x) =>
      String(x.itemName || "")
        .trim()
        .toLowerCase()
        .includes(q)
    )
  );
}

function priceInfo(item) {
  const ah = item?.ah || {};
  const single = ah.single || {};
  const stack = ah.stack || {};

  return {
    itemId: item.itemId,
    itemName: item.itemName,
    categorySlug: item.categorySlug,
    asOf: item.asOf,

    single: {
      lastSale: single.lastSale ?? null,
      lastSaleDate: single.lastSaleDate ?? null,
      avg: single.avg ?? null,
      median: single.median ?? null,
      volume: single.volume ?? 0,
      min: single.min ?? null,
      max: single.max ?? null,
      stock: ah.currentStock ?? 0
    },

    stack: {
      lastSale: stack.lastSale ?? null,
      lastSaleDate: stack.lastSaleDate ?? null,
      avg: stack.avg ?? null,
      median: stack.median ?? null,
      volume: stack.volume ?? 0,
      min: stack.min ?? null,
      max: stack.max ?? null,
      stock: ah.currentStackStock ?? 0
    },

    bazaar: item.bazaar ?? null
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    tokenConfigured: !!PSXI_TOKEN
  });
});

app.get("/api/market", async (req, res) => {
  try {
    const market = await getMarket();
    res.json(market);
  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

app.get("/api/item", async (req, res) => {
  try {
    const market = await getMarket();
    const items = getMarketItems(market);

    const item = findItem(items, req.query.search);

    if (!item) {
      return res.status(404).json({
        error: "Item not found",
        itemCount: items.length
      });
    }

    res.json(priceInfo(item));
  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

app.get("/api/item/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);

    const market = await getMarket();
    const items = getMarketItems(market);

    const item = items.find(
      (x) => Number(x.itemId) === id
    );

    if (!item) {
      return res.status(404).json({
        error: "Item not found"
      });
    }

    res.json(priceInfo(item));
  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

app.get("/api/craft/:itemId", async (req, res) => {
  try {
    const itemId = Number(req.params.itemId);

    if (!Number.isFinite(itemId)) {
      return res.status(400).json({
        error: "Invalid itemId"
      });
    }

    const craft = await psxiFetch(
      CRAFT_ITEM_URL(itemId)
    );

    res.json(craft);
  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

app.get("/api/item-with-craft", async (req, res) => {
  try {
    const market = await getMarket();
    const items = getMarketItems(market);

    const item = findItem(items, req.query.search);

    if (!item) {
      return res.status(404).json({
        error: "Item not found"
      });
    }

    let craft = null;
    let craftError = null;

    try {
      craft = await psxiFetch(
        CRAFT_ITEM_URL(item.itemId)
      );
    } catch (e) {
      craftError = e.message;
    }

    res.json({
      market: priceInfo(item),
      craft,
      craftError
    });
  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `HorizonXI Profit Scanner running on port ${PORT}`
  );
});
