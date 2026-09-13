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

  const r = await fetch(url, { headers: headers() });
  const text = await r.text();

  if (!r.ok) {
    throw new Error(`PSXI ${r.status}: ${text.slice(0, 300)}`);
  }

  return JSON.parse(text);
}

async function getMarket() {
  const now = Date.now();

  if (marketCache && now - marketCacheTime < MARKET_CACHE_MS) {
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

function normalizeName(s) {
  return String(s || "").trim().toLowerCase();
}

function findItem(items, query) {
  const q = normalizeName(query);

  return (
    items.find(x => normalizeName(x.itemName) === q) ||
    items.find(x => normalizeName(x.itemName).includes(q))
  );
}

function marketInfo(item) {
  const ah = item?.ah || {};
  const single = ah.single || {};
  const stack = ah.stack || {};

  return {
    itemId: item.itemId,
    itemName: item.itemName,
    categorySlug: item.categorySlug,
    asOf: item.asOf,
    currentStock: ah.currentStock ?? 0,
    currentStackStock: ah.currentStackStock ?? 0,
    single,
    stack,
    bazaar: item.bazaar ?? null
  };
}

function chooseUnitPrice(item) {
  if (!item) {
    return {
      unitPrice: null,
      source: "missing",
      detail: null
    };
  }

  const ah = item.ah || {};
  const single = ah.single || {};
  const stack = ah.stack || {};

  const singlePrice =
    single.lastSale ??
    single.median ??
    single.avg ??
    null;

  // مبدئيًا ما نحول stack إلى unit لأن stack size مو موجود في market payload.
  // لذلك نستخدم سعر single للمواد في أول اختبار.
  if (singlePrice != null) {
    return {
      unitPrice: Number(singlePrice),
      source: "single",
      detail: single
    };
  }

  return {
    unitPrice: null,
    source: "unpriced",
    detail: null
  };
}

async function calculateProfitByItemName(search) {
  const market = await getMarket();
  const items = getMarketItems(market);

  const outputItem = findItem(items, search);

  if (!outputItem) {
    throw new Error("Output item not found");
  }

  const craftData = await psxiFetch(CRAFT_ITEM_URL(outputItem.itemId));

  const recipes = craftData?.recipes || [];

  if (!recipes.length) {
    throw new Error("No craft recipes found");
  }

  const recipe = recipes[0];

  const outputQty = Number(recipe?.result?.qty || 1);

  const outputPriceInfo = chooseUnitPrice(outputItem);
  const outputUnitPrice = outputPriceInfo.unitPrice;

  if (outputUnitPrice == null) {
    throw new Error("Output item has no usable single price");
  }

  const crystalName = recipe?.crystal?.name || null;
  const crystalItem = crystalName ? findItem(items, crystalName) : null;
  const crystalPriceInfo = chooseUnitPrice(crystalItem);

  let materialCost = 0;
  const materials = [];

  if (crystalName) {
    materials.push({
      type: "crystal",
      itemName: crystalName,
      qty: 1,
      unitPrice: crystalPriceInfo.unitPrice,
      source: crystalPriceInfo.source,
      total:
        crystalPriceInfo.unitPrice != null
          ? crystalPriceInfo.unitPrice
          : null
    });

    if (crystalPriceInfo.unitPrice != null) {
      materialCost += crystalPriceInfo.unitPrice;
    }
  }

  for (const ing of recipe.ingredients || []) {
    const item = findItem(items, ing.name);
    const priceInfo = chooseUnitPrice(item);

    const qty = Number(ing.qty || 1);
    const total =
      priceInfo.unitPrice != null
        ? priceInfo.unitPrice * qty
        : null;

    materials.push({
      type: "ingredient",
      itemId: ing.id,
      itemName: ing.name,
      qty,
      unitPrice: priceInfo.unitPrice,
      source: priceInfo.source,
      total
    });

    if (total != null) {
      materialCost += total;
    }
  }

  const saleRevenue = outputUnitPrice * outputQty;
  const grossProfit = saleRevenue - materialCost;
  const marginPct =
    materialCost > 0
      ? (grossProfit / materialCost) * 100
      : null;

  return {
    output: {
      itemId: outputItem.itemId,
      itemName: outputItem.itemName,
      qty: outputQty,
      unitPrice: outputUnitPrice,
      revenue: saleRevenue,
      volume7d: outputItem?.ah?.single?.volume ?? 0,
      stock: outputItem?.ah?.currentStock ?? 0
    },

    recipe: {
      recipeId: recipe.id,
      crystal: recipe.crystal,
      skills: recipe.skills,
      ingredients: recipe.ingredients,
      tiers: recipe.tiers
    },

    materials,

    totals: {
      materialCost,
      saleRevenue,
      grossProfit,
      marginPct:
        marginPct != null
          ? Number(marginPct.toFixed(2))
          : null
    },

    note:
      "First profit-engine test uses SINGLE market prices only. Stack-size optimization will be added next."
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    tokenConfigured: !!PSXI_TOKEN
  });
});

app.get("/api/item", async (req, res) => {
  try {
    const market = await getMarket();
    const items = getMarketItems(market);

    const item = findItem(items, req.query.search);

    if (!item) {
      return res.status(404).json({
        error: "Item not found"
      });
    }

    res.json(marketInfo(item));
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

    const craft = await psxiFetch(CRAFT_ITEM_URL(item.itemId));

    res.json({
      market: marketInfo(item),
      craft
    });
  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

app.get("/api/profit", async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();

    if (!search) {
      return res.status(400).json({
        error: "search required"
      });
    }

    const result = await calculateProfitByItemName(search);
    res.json(result);

  } catch (e) {
    res.status(500).json({
      error: e.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`HorizonXI Profit Scanner running on port ${PORT}`);
});
