import express from "express";

const app = express();
app.use(express.static("."));

const PORT = process.env.PORT || 3000;
const PSXI_TOKEN = process.env.PSXI_TOKEN;

const MARKET_URL =
  "https://www.psxi.gg/api/v1/market/horizonxi";

const CRAFT_ITEM_URL = (itemId) =>
  `https://www.psxi.gg/api/v1/craft/horizonxi/item/${itemId}`;


/* =========================================================
   CACHE
========================================================= */

let marketCache = null;
let marketCacheTime = 0;

const MARKET_CACHE_MS =
  10 * 60 * 1000;

/*
  Craft results stay cached in memory while
  the Render process remains alive.
*/

const craftCache = new Map();


/* =========================================================
   VERIFIED STACK SIZES

   IMPORTANT:
   Unknown stack sizes NEVER use guessed stack prices.
   They fall back to Single pricing.
========================================================= */

const STACK_SIZE_BY_ID = {

  /* Crystals */
  4096: 12, // Fire Crystal
  4097: 12, // Ice Crystal
  4098: 12, // Wind Crystal
  4099: 12, // Earth Crystal
  4100: 12, // Lightning Crystal
  4101: 12, // Water Crystal
  4102: 12, // Light Crystal
  4103: 12, // Dark Crystal

  /* Verified materials used during testing */
  719: 12,  // Ebony Lumber
  1300: 12  // Ice Bead
};


/* =========================================================
   PSXI
========================================================= */

function headers() {
  return {
    accept: "application/json",
    "user-agent":
      "HorizonXI-Profit-Scanner/1.0",

    Authorization:
      `Bearer ${PSXI_TOKEN}`
  };
}


async function psxiFetch(url) {

  if (!PSXI_TOKEN) {
    throw new Error(
      "PSXI_TOKEN is not configured"
    );
  }

  const response =
    await fetch(url, {
      headers: headers()
    });

  const text =
    await response.text();

  if (!response.ok) {

    const error =
      new Error(
        `PSXI ${response.status}: ${text.slice(0, 300)}`
      );

    error.status =
      response.status;

    throw error;
  }

  return JSON.parse(text);
}


/* =========================================================
   MARKET
========================================================= */

async function getMarket() {

  const now =
    Date.now();

  if (
    marketCache &&
    now - marketCacheTime <
      MARKET_CACHE_MS
  ) {
    return marketCache;
  }

  marketCache =
    await psxiFetch(
      MARKET_URL
    );

  marketCacheTime =
    now;

  return marketCache;
}


function getMarketItems(market) {

  if (Array.isArray(market)) {
    return market;
  }

  if (
    Array.isArray(
      market?.data
    )
  ) {
    return market.data;
  }

  if (
    Array.isArray(
      market?.items
    )
  ) {
    return market.items;
  }

  return [];
}


/* =========================================================
   ITEM SEARCH
========================================================= */

function normalizeName(value) {

  return String(
    value || ""
  )
    .trim()
    .toLowerCase();
}


function findItem(
  items,
  search
) {

  const q =
    normalizeName(search);

  if (!q) {
    return null;
  }

  const exact =
    items.find(
      item =>
        normalizeName(
          item.itemName
        ) === q
    );

  if (exact) {
    return exact;
  }

  return items.find(
    item =>
      normalizeName(
        item.itemName
      ).includes(q)
  );
}


function findItemById(
  items,
  id
) {

  return items.find(
    item =>
      Number(item.itemId) ===
      Number(id)
  );
}


/* =========================================================
   PRICE HELPERS
========================================================= */

function getSinglePrice(item) {

  const single =
    item?.ah?.single || {};

  const price =
    single.lastSale ??
    single.median ??
    single.avg ??
    null;

  return (
    price != null
      ? Number(price)
      : null
  );
}


function getStackPrice(item) {

  const stack =
    item?.ah?.stack || {};

  const price =
    stack.lastSale ??
    stack.median ??
    stack.avg ??
    null;

  return (
    price != null
      ? Number(price)
      : null
  );
}


function getKnownStackSize(item) {

  if (!item) {
    return null;
  }

  return (
    STACK_SIZE_BY_ID[
      Number(item.itemId)
    ] ?? null
  );
}


function hasStackData(item) {

  const stack =
    item?.ah?.stack || {};

  return (
    stack.lastSale != null ||
    stack.avg != null ||
    stack.median != null ||
    Number(
      stack.volume || 0
    ) > 0 ||
    Number(
      item?.ah?.currentStackStock || 0
    ) > 0
  );
}


function isStackable(item) {
  return hasStackData(item);
}


/* =========================================================
   MATERIAL PRICE OPTIMIZER
========================================================= */

function getBestMaterialPrice(item) {

  if (!item) {

    return {
      found: false,
      selectedUnitPrice: null,
      selectedMode: "missing"
    };
  }

  const singlePrice =
    getSinglePrice(item);

  const stackPrice =
    getStackPrice(item);

  const stackSize =
    getKnownStackSize(item);

  const stackable =
    isStackable(item);

  let stackUnitPrice =
    null;

  if (
    stackable &&
    stackSize &&
    stackPrice != null
  ) {

    stackUnitPrice =
      stackPrice /
      stackSize;
  }

  let selectedUnitPrice =
    null;

  let selectedMode =
    "unpriced";


  if (
    singlePrice != null &&
    stackUnitPrice != null
  ) {

    if (
      stackUnitPrice <
      singlePrice
    ) {

      selectedUnitPrice =
        stackUnitPrice;

      selectedMode =
        "stack";

    } else {

      selectedUnitPrice =
        singlePrice;

      selectedMode =
        "single";
    }

  } else if (
    singlePrice != null
  ) {

    selectedUnitPrice =
      singlePrice;

    selectedMode =
      "single";

  } else if (
    stackUnitPrice != null
  ) {

    selectedUnitPrice =
      stackUnitPrice;

    selectedMode =
      "stack";
  }


  return {

    found: true,

    stackable,

    stackSize,

    singlePrice,

    stackPrice,

    stackUnitPrice:
      stackUnitPrice != null
        ? Number(
            stackUnitPrice.toFixed(2)
          )
        : null,

    selectedUnitPrice:
      selectedUnitPrice != null
        ? Number(
            selectedUnitPrice.toFixed(2)
          )
        : null,

    selectedMode,

    singleStock:
      Number(
        item?.ah?.currentStock || 0
      ),

    stackStock:
      Number(
        item?.ah?.currentStackStock || 0
      )
  };
}


/* =========================================================
   LIQUIDITY
========================================================= */

function getLiquidityInfo(item) {

  const stock =
    Number(
      item?.ah?.currentStock || 0
    );

  const volume7d =
    Number(
      item?.ah?.single?.volume || 0
    );

  const salesPerDay =
    volume7d / 7;

  let daysToSell =
    null;

  if (salesPerDay > 0) {

    daysToSell =
      stock /
      salesPerDay;
  }

  let liquidity =
    "dead";

  if (volume7d >= 1) {
    liquidity =
      "very-slow";
  }

  if (volume7d >= 7) {
    liquidity =
      "slow";
  }

  if (volume7d >= 14) {
    liquidity =
      "medium";
  }

  if (volume7d >= 35) {
    liquidity =
      "fast";
  }

  if (volume7d >= 70) {
    liquidity =
      "very-fast";
  }

  const saturated =
    daysToSell != null &&
    daysToSell > 14;

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
   LAST SALE AGE
========================================================= */

function getLastSaleAgeDays(item) {

  const date =
    item?.ah?.single
      ?.lastSaleDate;

  if (!date) {
    return null;
  }

  const parsed =
    new Date(date);

  if (
    Number.isNaN(
      parsed.getTime()
    )
  ) {
    return null;
  }

  const diff =
    Date.now() -
    parsed.getTime();

  return Number(
    (
      diff /
      86400000
    ).toFixed(2)
  );
}


/* =========================================================
   MARKET CANDIDATE FILTER

   BEFORE spending Craft API requests,
   remove dead / slow / saturated items.
========================================================= */

function buildCandidates(items) {

  const candidates =
    [];

  for (
    const item
    of items
  ) {

    const price =
      getSinglePrice(item);

    if (
      price == null ||
      price <= 0
    ) {
      continue;
    }

    const liquidity =
      getLiquidityInfo(item);

    /*
      Require meaningful movement.
    */

    if (
      liquidity.volume7d < 14
    ) {
      continue;
    }

    /*
      Reject heavily saturated markets.
    */

    if (
      liquidity.daysToSell != null &&
      liquidity.daysToSell > 14
    ) {
      continue;
    }

    const lastSaleAge =
      getLastSaleAgeDays(item);

    /*
      Recent sale required.
    */

    if (
      lastSaleAge != null &&
      lastSaleAge > 14
    ) {
      continue;
    }

    /*
      Avoid spending craft calls
      on extremely cheap outputs.
    */

    if (price < 1000) {
      continue;
    }

    /*
      Market potential before
      knowing material costs.
    */

    const marketPotential =
      price *
      liquidity.salesPerDay;

    candidates.push({

      item,

      price,

      liquidity,

      lastSaleAge,

      marketPotential
    });
  }


  candidates.sort(
    (a, b) =>
      b.marketPotential -
      a.marketPotential
  );

  return candidates;
}


/* =========================================================
   CRAFT CACHE
========================================================= */

async function getCraftData(
  itemId
) {

  const id =
    Number(itemId);

  if (
    craftCache.has(id)
  ) {

    return craftCache.get(id);
  }

  try {

    const data =
      await psxiFetch(
        CRAFT_ITEM_URL(id)
      );

    craftCache.set(
      id,
      {
        ok: true,
        data
      }
    );

    return {
      ok: true,
      data
    };

  } catch (error) {

    /*
      Cache non-craftable / failed items
      so we do not repeatedly waste API requests.
    */

    craftCache.set(
      id,
      {
        ok: false,
        error:
          error.message
      }
    );

    return {
      ok: false,
      error:
        error.message
    };
  }
}


/* =========================================================
   CRAFT PARSER
========================================================= */

function extractRecipes(
  craftData
) {

  if (
    !Array.isArray(
      craftData?.recipes
    )
  ) {
    return [];
  }

  return craftData.recipes
    .map(
      entry => {

        if (entry?.recipe) {

          return {

            recipe:
              entry.recipe,

            tiers:
              Array.isArray(
                entry.tiers
              )
                ? entry.tiers
                : []
          };
        }

        return {

          recipe:
            entry,

          tiers:
            Array.isArray(
              entry?.tiers
            )
              ? entry.tiers
              : []
        };
      }
    )
    .filter(
      x => x.recipe
    );
}


/* =========================================================
   ANALYZE ONE RECIPE
========================================================= */

function analyzeRecipe(
  outputItem,
  recipeEntry,
  marketItems
) {

  const recipe =
    recipeEntry.recipe;

  const outputPrice =
    getSinglePrice(
      outputItem
    );

  if (
    outputPrice == null
  ) {
    return null;
  }

  const outputQty =
    Number(
      recipe?.result?.qty ||
      1
    );

  const saleRevenue =
    outputPrice *
    outputQty;

  let materialCost =
    0;

  let missingPrice =
    false;

  const materials =
    [];


  /* Crystal */

  if (
    recipe?.crystal?.name
  ) {

    const crystalItem =
      findItemById(
        marketItems,
        recipe.crystal.id
      ) ||
      findItem(
        marketItems,
        recipe.crystal.name
      );

    const pricing =
      getBestMaterialPrice(
        crystalItem
      );

    const qty = 1;

    const total =
      pricing.selectedUnitPrice != null
        ? pricing.selectedUnitPrice *
          qty
        : null;

    if (total == null) {

      missingPrice =
        true;

    } else {

      materialCost +=
        total;
    }

    materials.push({

      type:
        "crystal",

      itemId:
        recipe.crystal.id,

      itemName:
        recipe.crystal.name,

      qty,

      stackSize:
        pricing.stackSize,

      singlePrice:
        pricing.singlePrice,

      stackPrice:
        pricing.stackPrice,

      stackUnitPrice:
        pricing.stackUnitPrice,

      bestUnitPrice:
        pricing.selectedUnitPrice,

      purchaseMode:
        pricing.selectedMode,

      totalCost:
        total
    });
  }


  /* Ingredients */

  for (
    const ingredient
    of recipe?.ingredients ||
    []
  ) {

    const ingredientItem =
      findItemById(
        marketItems,
        ingredient.id
      ) ||
      findItem(
        marketItems,
        ingredient.name
      );

    const pricing =
      getBestMaterialPrice(
        ingredientItem
      );

    const qty =
      Number(
        ingredient.qty ||
        1
      );

    const total =
      pricing.selectedUnitPrice != null
        ? pricing.selectedUnitPrice *
          qty
        : null;

    if (total == null) {

      missingPrice =
        true;

    } else {

      materialCost +=
        total;
    }

    materials.push({

      type:
        "ingredient",

      itemId:
        ingredient.id,

      itemName:
        ingredient.name,

      qty,

      stackSize:
        pricing.stackSize,

      singlePrice:
        pricing.singlePrice,

      stackPrice:
        pricing.stackPrice,

      stackUnitPrice:
        pricing.stackUnitPrice,

      bestUnitPrice:
        pricing.selectedUnitPrice,

      purchaseMode:
        pricing.selectedMode,

      totalCost:
        total
    });
  }


  if (missingPrice) {
    return null;
  }


  materialCost =
    Number(
      materialCost.toFixed(2)
    );

  const grossProfit =
    Number(
      (
        saleRevenue -
        materialCost
      ).toFixed(2)
    );

  const marginPct =
    materialCost > 0
      ? Number(
          (
            grossProfit /
            materialCost *
            100
          ).toFixed(2)
        )
      : null;

  const liquidity =
    getLiquidityInfo(
      outputItem
    );


  /*
    Hard rules for Top 20.
  */

  if (
    grossProfit <= 0
  ) {
    return null;
  }

  if (
    !liquidity.top20Eligible
  ) {
    return null;
  }

  if (
    liquidity.saturated
  ) {
    return null;
  }


  /* =====================================================
     OPPORTUNITY SCORE

     Profit       40%
     Speed        30%
     Margin       15%
     Low stock    15%
  ===================================================== */

  const profitScore =
    Math.min(
      grossProfit / 1000,
      100
    );

  const speedScore =
    Math.min(
      liquidity.salesPerDay *
        10,
      100
    );

  const marginScore =
    Math.min(
      Math.max(
        marginPct || 0,
        0
      ),
      100
    );

  let stockScore =
    100;

  if (
    liquidity.daysToSell != null
  ) {

    stockScore =
      Math.max(
        0,
        100 -
        (
          liquidity.daysToSell /
          14 *
          100
        )
      );
  }


  let score =

    profitScore * 0.40 +

    speedScore * 0.30 +

    marginScore * 0.15 +

    stockScore * 0.15;


  score =
    Number(
      score.toFixed(2)
    );


  return {

    itemId:
      outputItem.itemId,

    itemName:
      outputItem.itemName,

    categorySlug:
      outputItem.categorySlug,

    recipeId:
      recipe.id,

    craftSkills:
      recipe.skills,

    outputQty,

    salePrice:
      outputPrice,

    saleRevenue,

    materialCost,

    profit:
      grossProfit,

    marginPct,

    volume7d:
      liquidity.volume7d,

    salesPerDay:
      liquidity.salesPerDay,

    currentStock:
      liquidity.stock,

    daysToSell:
      liquidity.daysToSell,

    liquidity:
      liquidity.liquidity,

    saturated:
      liquidity.saturated,

    score,

    lastSaleDate:
      outputItem?.ah?.single
        ?.lastSaleDate ??
      null,

    asOf:
      outputItem.asOf,

    materials
  };
}


/* =========================================================
   ANALYZE ONE CRAFT ITEM
========================================================= */

async function analyzeCraftItem(
  item,
  marketItems
) {

  const craftResult =
    await getCraftData(
      item.itemId
    );

  if (
    !craftResult.ok
  ) {
    return [];
  }

  const recipes =
    extractRecipes(
      craftResult.data
    );

  if (
    !recipes.length
  ) {
    return [];
  }

  const results =
    [];

  for (
    const recipe
    of recipes
  ) {

    const result =
      analyzeRecipe(
        item,
        recipe,
        marketItems
      );

    if (result) {
      results.push(
        result
      );
    }
  }

  return results;
}


/* =========================================================
   TOP 20 SCAN

   Each call checks at most 20 uncached craft candidates.
========================================================= */

async function runTop20Scan() {

  const market =
    await getMarket();

  const marketItems =
    getMarketItems(
      market
    );

  const candidates =
    buildCandidates(
      marketItems
    );


  /*
    First collect already cached craft items.
  */

  const opportunities =
    [];

  for (
    const candidate
    of candidates
  ) {

    const id =
      Number(
        candidate.item.itemId
      );

    if (
      !craftCache.has(id)
    ) {
      continue;
    }

    const cached =
      craftCache.get(id);

    if (
      !cached?.ok
    ) {
      continue;
    }

    const recipes =
      extractRecipes(
        cached.data
      );

    for (
      const recipe
      of recipes
    ) {

      const result =
        analyzeRecipe(
          candidate.item,
          recipe,
          marketItems
        );

      if (result) {
        opportunities.push(
          result
        );
      }
    }
  }


  /*
    Scan up to 20 NEW candidates.
  */

  const MAX_NEW_CALLS =
    20;

  let newCalls =
    0;

  let scannedNames =
    [];


  for (
    const candidate
    of candidates
  ) {

    if (
      newCalls >=
      MAX_NEW_CALLS
    ) {
      break;
    }

    const id =
      Number(
        candidate.item.itemId
      );

    if (
      craftCache.has(id)
    ) {
      continue;
    }

    newCalls++;

    scannedNames.push(
      candidate.item.itemName
    );

    const results =
      await analyzeCraftItem(
        candidate.item,
        marketItems
      );

    for (
      const result
      of results
    ) {

      opportunities.push(
        result
      );
    }
  }


  /*
    Deduplicate recipe results.
  */

  const dedupe =
    new Map();

  for (
    const item
    of opportunities
  ) {

    const key =
      `${item.itemId}:${item.recipeId}`;

    const existing =
      dedupe.get(key);

    if (
      !existing ||
      item.score >
      existing.score
    ) {

      dedupe.set(
        key,
        item
      );
    }
  }


  const ranked =
    Array.from(
      dedupe.values()
    );


  ranked.sort(
    (a, b) => {

      if (
        b.score !== a.score
      ) {
        return (
          b.score -
          a.score
        );
      }

      return (
        b.profit -
        a.profit
      );
    }
  );


  const top20 =
    ranked.slice(
      0,
      20
    );


  return {

    generatedAt:
      new Date().toISOString(),

    marketItemCount:
      marketItems.length,

    candidateCount:
      candidates.length,

    craftCacheCount:
      craftCache.size,

    newCraftRequestsThisScan:
      newCalls,

    scannedThisRun:
      scannedNames,

    validOpportunities:
      ranked.length,

    top20,

    note:
      "Each scan checks up to 20 new liquid market candidates to stay safely below PSXI API limits. Run again later to expand the craft cache and improve Top 20 coverage. Unknown material stack sizes use conservative Single pricing."
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
        !!PSXI_TOKEN,

      marketCached:
        !!marketCache,

      craftCacheCount:
        craftCache.size
    });
  }
);


/* Single item profit test */

app.get(
  "/api/profit",
  async (req, res) => {

    try {

      const search =
        String(
          req.query.search ||
          ""
        ).trim();

      if (!search) {

        return res
          .status(400)
          .json({
            error:
              "search required"
          });
      }

      const market =
        await getMarket();

      const items =
        getMarketItems(
          market
        );

      const item =
        findItem(
          items,
          search
        );

      if (!item) {

        return res
          .status(404)
          .json({
            error:
              "Item not found"
          });
      }

      const craftResult =
        await getCraftData(
          item.itemId
        );

      if (
        !craftResult.ok
      ) {

        return res
          .status(404)
          .json({
            error:
              "No craft data",
            details:
              craftResult.error
          });
      }

      const recipes =
        extractRecipes(
          craftResult.data
        );

      const analyzed =
        recipes.map(
          recipe =>
            analyzeRecipe(
              item,
              recipe,
              items
            )
        );

      res.json({

        itemName:
          item.itemName,

        market:
          item,

        recipes:
          recipes,

        profitableOpportunities:
          analyzed.filter(Boolean)
      });

    } catch (e) {

      res
        .status(500)
        .json({
          error:
            e.message
        });
    }
  }
);


/* TOP 20 */

app.get(
  "/api/top20",
  async (req, res) => {

    try {

      const result =
        await runTop20Scan();

      res.json(result);

    } catch (e) {

      res
        .status(500)
        .json({
          error:
            e.message
        });
    }
  }
);


/* Clear only in-memory Craft cache */

app.get(
  "/api/reset-scan",
  (req, res) => {

    craftCache.clear();

    res.json({
      ok: true,
      message:
        "Craft scan cache cleared"
    });
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
