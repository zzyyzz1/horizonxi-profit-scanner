import express from "express";

const app = express();
app.use(express.static("."));

const PORT = process.env.PORT || 3000;
const PSXI_TOKEN = process.env.PSXI_TOKEN;

const MARKET_URL =
  "https://www.psxi.gg/api/v1/market/horizonxi";

const CRAFT_ITEM_URL = (itemId) =>
  `https://www.psxi.gg/api/v1/craft/horizonxi/item/${itemId}`;

let marketCache = null;
let marketCacheTime = 0;

const MARKET_CACHE_MS = 5 * 60 * 1000;


/* =========================================================
   PSXI
========================================================= */

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
    throw new Error(
      `PSXI ${r.status}: ${text.slice(0, 400)}`
    );
  }

  return JSON.parse(text);
}


/* =========================================================
   MARKET
========================================================= */

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
  if (Array.isArray(market)) {
    return market;
  }

  if (Array.isArray(market?.data)) {
    return market.data;
  }

  if (Array.isArray(market?.items)) {
    return market.items;
  }

  return [];
}

function normalizeName(name) {
  return String(name || "")
    .trim()
    .toLowerCase();
}

function findItem(items, search) {
  const q = normalizeName(search);

  if (!q) {
    return null;
  }

  const exact = items.find(
    item =>
      normalizeName(item.itemName) === q
  );

  if (exact) {
    return exact;
  }

  return items.find(
    item =>
      normalizeName(item.itemName).includes(q)
  );
}

function findItemById(items, id) {
  return items.find(
    item =>
      Number(item.itemId) === Number(id)
  );
}


/* =========================================================
   STACK / NON-STACK DETECTION
========================================================= */

function hasStackMarketData(item) {
  const stack = item?.ah?.stack || {};

  return (
    stack.lastSale != null ||
    stack.avg != null ||
    stack.median != null ||
    Number(stack.volume || 0) > 0 ||
    Number(item?.ah?.currentStackStock || 0) > 0
  );
}

function isStackable(item) {
  return hasStackMarketData(item);
}


/* =========================================================
   LIQUIDITY / SPEED OF SALE
========================================================= */

function getLiquidityInfo(item) {
  const stock =
    Number(item?.ah?.currentStock || 0);

  const volume7d =
    Number(item?.ah?.single?.volume || 0);

  const salesPerDay =
    volume7d / 7;

  let daysToSell = null;

  if (salesPerDay > 0) {
    daysToSell =
      stock / salesPerDay;
  }

  let liquidity = "dead";

  if (volume7d >= 1) {
    liquidity = "very-slow";
  }

  if (volume7d >= 7) {
    liquidity = "slow";
  }

  if (volume7d >= 14) {
    liquidity = "medium";
  }

  if (volume7d >= 35) {
    liquidity = "fast";
  }

  if (volume7d >= 70) {
    liquidity = "very-fast";
  }

  let saturated = false;

  if (
    daysToSell != null &&
    daysToSell > 14
  ) {
    saturated = true;
  }

  /*
    شروط الدخول إلى Top 20:

    - لازم فيه مبيعات حقيقية
    - على الأقل 14 مبيعة خلال 7 أيام
    - المخزون الحالي ما يحتاج أكثر من 14 يوم للتصريف
  */

  const top20Eligible =
    volume7d >= 14 &&
    (
      daysToSell == null ||
      daysToSell <= 14
    );

  return {
    stock,
    volume7d,

    salesPerDay:
      Number(
        salesPerDay.toFixed(2)
      ),

    daysToSell:
      daysToSell != null
        ? Number(
            daysToSell.toFixed(2)
          )
        : null,

    liquidity,
    saturated,
    top20Eligible
  };
}


/* =========================================================
   PRICES
========================================================= */

function getSinglePrice(item) {
  const single = item?.ah?.single || {};

  const price =
    single.lastSale ??
    single.median ??
    single.avg ??
    null;

  return price != null
    ? Number(price)
    : null;
}

function getStackPrice(item) {
  const stack = item?.ah?.stack || {};

  const price =
    stack.lastSale ??
    stack.median ??
    stack.avg ??
    null;

  return price != null
    ? Number(price)
    : null;
}

function getPriceInfo(item) {
  if (!item) {
    return {
      found: false,
      stackable: false,
      singlePrice: null,
      stackPrice: null,
      selectedPrice: null,
      selectedMode: "missing"
    };
  }

  const stackable = isStackable(item);
  const singlePrice = getSinglePrice(item);
  const stackPrice = getStackPrice(item);

  let selectedPrice = null;
  let selectedMode = "unpriced";

  /*
    حالياً نستخدم Single للوحدة.
    Stack optimization الحقيقي بنضيفه بعد ما نثبت stack size.
  */

  if (singlePrice != null) {
    selectedPrice = singlePrice;
    selectedMode = "single";
  }

  return {
    found: true,
    stackable,
    singlePrice,
    stackPrice,
    selectedPrice,
    selectedMode,

    singleStock:
      Number(item?.ah?.currentStock || 0),

    stackStock:
      Number(item?.ah?.currentStackStock || 0),

    singleVolume7d:
      Number(item?.ah?.single?.volume || 0),

    stackVolume7d:
      Number(item?.ah?.stack?.volume || 0),

    asOf:
      item?.asOf ?? null
  };
}


/* =========================================================
   CRAFT STRUCTURE
========================================================= */

function extractRecipeEntries(craftData) {
  if (!Array.isArray(craftData?.recipes)) {
    return [];
  }

  return craftData.recipes
    .map(entry => {
      if (entry?.recipe) {
        return {
          recipe: entry.recipe,
          tiers:
            Array.isArray(entry.tiers)
              ? entry.tiers
              : []
        };
      }

      return {
        recipe: entry,
        tiers:
          Array.isArray(entry?.tiers)
            ? entry.tiers
            : []
      };
    })
    .filter(x => x.recipe);
}


/* =========================================================
   PROFIT ENGINE
========================================================= */

async function calculateProfit(search) {
  const market = await getMarket();
  const items = getMarketItems(market);

  const outputItem = findItem(
    items,
    search
  );

  if (!outputItem) {
    throw new Error(
      `Output item not found: ${search}`
    );
  }

  const craftData =
    await psxiFetch(
      CRAFT_ITEM_URL(
        outputItem.itemId
      )
    );

  const recipeEntries =
    extractRecipeEntries(
      craftData
    );

  if (!recipeEntries.length) {
    throw new Error(
      `No recipes found for ${outputItem.itemName}`
    );
  }

  const recipeEntry =
    recipeEntries[0];

  const recipe =
    recipeEntry.recipe;

  const tiers =
    recipeEntry.tiers;

  const outputQty =
    Number(
      recipe?.result?.qty || 1
    );

  const outputPrice =
    getPriceInfo(
      outputItem
    );

  if (
    outputPrice.selectedPrice == null
  ) {
    throw new Error(
      "Output item has no usable sale price"
    );
  }


  /* -------------------------
     OUTPUT
  ------------------------- */

  const outputRevenue =
    outputPrice.selectedPrice *
    outputQty;


  /* -------------------------
     MATERIALS
  ------------------------- */

  const materials = [];

  let materialCost = 0;
  let missingPrice = false;


  /* Crystal */

  if (recipe?.crystal?.name) {
    const crystalItem =
      findItemById(
        items,
        recipe.crystal.id
      ) ||
      findItem(
        items,
        recipe.crystal.name
      );

    const price =
      getPriceInfo(
        crystalItem
      );

    const qty = 1;

    const total =
      price.selectedPrice != null
        ? price.selectedPrice * qty
        : null;

    if (total == null) {
      missingPrice = true;
    } else {
      materialCost += total;
    }

    materials.push({
      type: "crystal",

      itemId:
        recipe.crystal.id ?? null,

      itemName:
        recipe.crystal.name,

      qty,

      stackable:
        price.stackable,

      singlePrice:
        price.singlePrice,

      stackPrice:
        price.stackPrice,

      priceUsed:
        price.selectedPrice,

      priceMode:
        price.selectedMode,

      totalCost:
        total,

      singleStock:
        price.singleStock,

      stackStock:
        price.stackStock
    });
  }


  /* Ingredients */

  for (
    const ingredient
    of recipe?.ingredients || []
  ) {
    const marketItem =
      findItemById(
        items,
        ingredient.id
      ) ||
      findItem(
        items,
        ingredient.name
      );

    const price =
      getPriceInfo(
        marketItem
      );

    const qty =
      Number(
        ingredient.qty || 1
      );

    const total =
      price.selectedPrice != null
        ? price.selectedPrice * qty
        : null;

    if (total == null) {
      missingPrice = true;
    } else {
      materialCost += total;
    }

    materials.push({
      type: "ingredient",

      itemId:
        ingredient.id ?? null,

      itemName:
        ingredient.name,

      qty,

      stackable:
        price.stackable,

      singlePrice:
        price.singlePrice,

      stackPrice:
        price.stackPrice,

      priceUsed:
        price.selectedPrice,

      priceMode:
        price.selectedMode,

      totalCost:
        total,

      singleStock:
        price.singleStock,

      stackStock:
        price.stackStock
    });
  }


  /* -------------------------
     PROFIT
  ------------------------- */

  const grossProfit =
    missingPrice
      ? null
      : outputRevenue -
        materialCost;

  const marginPct =
    grossProfit != null &&
    materialCost > 0
      ? (
          grossProfit /
          materialCost *
          100
        )
      : null;


  /* -------------------------
     LIQUIDITY
  ------------------------- */

  const liquidity =
    getLiquidityInfo(
      outputItem
    );


  /* -------------------------
     OPPORTUNITY SCORE
  ------------------------- */

  let opportunityScore = null;

  if (
    grossProfit != null &&
    grossProfit > 0
  ) {
    const profitScore =
      Math.min(
        grossProfit / 1000,
        100
      );

    const marginScore =
      marginPct != null
        ? Math.min(
            Math.max(
              marginPct,
              0
            ),
            100
          )
        : 0;

    const speedScore =
      liquidity.salesPerDay > 0
        ? Math.min(
            liquidity.salesPerDay * 10,
            100
          )
        : 0;

    const saturationPenalty =
      liquidity.saturated
        ? 30
        : 0;

    opportunityScore =
      (
        profitScore * 0.45 +
        marginScore * 0.20 +
        speedScore * 0.35 -
        saturationPenalty
      );

    opportunityScore =
      Number(
        Math.max(
          0,
          opportunityScore
        ).toFixed(2)
      );
  }


  /* -------------------------
     RESULT
  ------------------------- */

  return {
    output: {
      itemId:
        outputItem.itemId,

      itemName:
        outputItem.itemName,

      qty:
        outputQty,

      stackable:
        outputPrice.stackable,

      saleMode:
        outputPrice.stackable
          ? "single-currently"
          : "single-only",

      singlePrice:
        outputPrice.singlePrice,

      stackPrice:
        outputPrice.stackPrice,

      unitPriceUsed:
        outputPrice.selectedPrice,

      revenue:
        outputRevenue,

      volume7d:
        Number(
          outputItem?.ah?.single?.volume || 0
        ),

      stock:
        Number(
          outputItem?.ah?.currentStock || 0
        ),

      stackStock:
        Number(
          outputItem?.ah?.currentStackStock || 0
        ),

      asOf:
        outputItem.asOf
    },

    recipe: {
      recipeId:
        recipe.id,

      result:
        recipe.result,

      crystal:
        recipe.crystal,

      ingredients:
        recipe.ingredients,

      skills:
        recipe.skills,

      desynth:
        recipe.desynth ?? false,

      tiers
    },

    materials,

    totals: {
      materialCost:
        missingPrice
          ? null
          : materialCost,

      saleRevenue:
        outputRevenue,

      grossProfit,

      marginPct:
        marginPct != null
          ? Number(
              marginPct.toFixed(2)
            )
          : null
    },

    liquidity,

    opportunity: {
      eligibleForTop20:
        liquidity.top20Eligible &&
        grossProfit != null &&
        grossProfit > 0,

      score:
        opportunityScore
    },

    pricing: {
      missingMaterialPrice:
        missingPrice,

      stackOptimization:
        "pending-stack-size-data",

      rule:
        "Non-stackable outputs use Single only. Stack-capable materials are detected separately. Exact stack unit optimization will be enabled after verified stack-size data is added."
    }
  };
}


/* =========================================================
   ROUTES
========================================================= */

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,
      tokenConfigured:
        !!PSXI_TOKEN
    });
  }
);


app.get(
  "/api/item",
  async (req, res) => {
    try {
      const market =
        await getMarket();

      const items =
        getMarketItems(
          market
        );

      const item =
        findItem(
          items,
          req.query.search
        );

      if (!item) {
        return res
          .status(404)
          .json({
            error:
              "Item not found"
          });
      }

      res.json({
        itemId:
          item.itemId,

        itemName:
          item.itemName,

        categorySlug:
          item.categorySlug,

        stackable:
          isStackable(item),

        prices:
          getPriceInfo(item),

        liquidity:
          getLiquidityInfo(item),

        ah:
          item.ah,

        bazaar:
          item.bazaar,

        asOf:
          item.asOf
      });

    } catch (e) {
      res
        .status(500)
        .json({
          error: e.message
        });
    }
  }
);


app.get(
  "/api/item-with-craft",
  async (req, res) => {
    try {
      const market =
        await getMarket();

      const items =
        getMarketItems(
          market
        );

      const item =
        findItem(
          items,
          req.query.search
        );

      if (!item) {
        return res
          .status(404)
          .json({
            error:
              "Item not found"
          });
      }

      const craft =
        await psxiFetch(
          CRAFT_ITEM_URL(
            item.itemId
          )
        );

      res.json({
        market: item,
        craft
      });

    } catch (e) {
      res
        .status(500)
        .json({
          error: e.message
        });
    }
  }
);


app.get(
  "/api/profit",
  async (req, res) => {
    try {
      const search =
        String(
          req.query.search || ""
        ).trim();

      if (!search) {
        return res
          .status(400)
          .json({
            error:
              "search required"
          });
      }

      const result =
        await calculateProfit(
          search
        );

      res.json(result);

    } catch (e) {
      res
        .status(500)
        .json({
          error: e.message
        });
    }
  }
);


app.listen(
  PORT,
  () => {
    console.log(
      `HorizonXI Profit Scanner running on port ${PORT}`
    );
  }
);
