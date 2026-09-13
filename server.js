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

const craftCache =
  new Map();

let top20Cache = null;
let top20CacheTime = 0;

const TOP20_SCAN_COOLDOWN_MS =
  2 * 60 * 1000;


/* =========================================================
   CATEGORY RULES

   automation is excluded because its recipe quantities /
   market behavior should not be treated like normal crafts.
========================================================= */

const EXCLUDED_CATEGORIES =
  new Set([
    "automation" ,
    "automatom"
  ]);


/* =========================================================
   VERIFIED STACK SIZES

   Unknown stack sizes use Single price only.
========================================================= */

const STACK_SIZE_BY_ID = {

  4096: 12, // Fire Crystal
  4097: 12, // Ice Crystal
  4098: 12, // Wind Crystal
  4099: 12, // Earth Crystal
  4100: 12, // Lightning Crystal
  4101: 12, // Water Crystal
  4102: 12, // Light Crystal
  4103: 12, // Dark Crystal

  719: 12,  // Ebony Lumber
  1300: 12  // Ice Bead
};


/* =========================================================
   PSXI
========================================================= */

function headers() {

  return {

    accept:
      "application/json",

    "user-agent":
      "HorizonXI-Profit-Scanner/2.1",

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
    await fetch(
      url,
      {
        headers: headers()
      }
    );

  const text =
    await response.text();

  if (!response.ok) {

    const error =
      new Error(
        `PSXI ${response.status}: ${text.slice(0, 350)}`
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

  if (
    Array.isArray(market)
  ) {
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
   SEARCH
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
      x =>
        normalizeName(
          x.itemName
        ) === q
    );

  if (exact) {
    return exact;
  }

  return items.find(
    x =>
      normalizeName(
        x.itemName
      ).includes(q)
  );
}


function findItemById(
  items,
  id
) {

  return items.find(
    x =>
      Number(
        x.itemId
      ) ===
      Number(id)
  );
}


/* =========================================================
   PRICES
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
      Number(
        item.itemId
      )
    ] ?? null
  );
}


/* =========================================================
   MATERIAL PRICE OPTIMIZER
========================================================= */

function getBestMaterialPrice(
  item
) {

  if (!item) {

    return {

      found: false,

      selectedUnitPrice:
        null,

      selectedMode:
        "missing"
    };
  }

  const singlePrice =
    getSinglePrice(item);

  const stackPrice =
    getStackPrice(item);

  const stackSize =
    getKnownStackSize(item);

  let stackUnitPrice =
    null;


  if (
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

    found:
      true,

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
        item?.ah
          ?.currentStock || 0
      ),

    stackStock:
      Number(
        item?.ah
          ?.currentStackStock || 0
      )
  };
}


/* =========================================================
   LIQUIDITY
========================================================= */

function getLastSaleAgeDays(
  item
) {

  const date =
    item?.ah?.single
      ?.lastSaleDate;

  if (!date) {
    return null;
  }

  const time =
    new Date(date)
      .getTime();

  if (
    Number.isNaN(time)
  ) {
    return null;
  }

  return Number(
    (
      (
        Date.now() -
        time
      ) /
      86400000
    ).toFixed(2)
  );
}


function getLiquidityInfo(
  item,
  outputQty = 1
) {

  const stock =
    Number(
      item?.ah
        ?.currentStock || 0
    );

  const volume7d =
    Number(
      item?.ah
        ?.single
        ?.volume || 0
    );

  const salesPerDay =
    volume7d / 7;


  let daysToClearMarket =
    null;

  if (
    salesPerDay > 0
  ) {

    daysToClearMarket =
      stock /
      salesPerDay;
  }


  let daysToSellCraftBatch =
    null;

  if (
    salesPerDay > 0
  ) {

    daysToSellCraftBatch =
      Number(outputQty) /
      salesPerDay;
  }


  let daysToClearAfterCraft =
    null;

  if (
    salesPerDay > 0
  ) {

    daysToClearAfterCraft =
      (
        stock +
        Number(outputQty)
      ) /
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
    (
      daysToClearMarket != null &&
      daysToClearMarket > 14
    );


  const top20Eligible =

    volume7d >= 14 &&

    salesPerDay > 0 &&

    (
      daysToClearMarket == null ||
      daysToClearMarket <= 14
    ) &&

    (
      daysToSellCraftBatch == null ||
      daysToSellCraftBatch <= 7
    ) &&

    (
      daysToClearAfterCraft == null ||
      daysToClearAfterCraft <= 14
    );


  return {

    stock,

    volume7d,

    salesPerDay:
      Number(
        salesPerDay.toFixed(2)
      ),

    daysToClearMarket:
      daysToClearMarket != null
        ? Number(
            daysToClearMarket.toFixed(2)
          )
        : null,

    daysToSellCraftBatch:
      daysToSellCraftBatch != null
        ? Number(
            daysToSellCraftBatch.toFixed(2)
          )
        : null,

    daysToClearAfterCraft:
      daysToClearAfterCraft != null
        ? Number(
            daysToClearAfterCraft.toFixed(2)
          )
        : null,

    liquidity,

    saturated,

    top20Eligible,

    lastSaleAgeDays:
      getLastSaleAgeDays(
        item
      )
  };
}


/* =========================================================
   CANDIDATE FILTER
========================================================= */

function buildCandidates(
  items
) {

  const candidates =
    [];


  for (
    const item
    of items
  ) {

    /*
      Remove automation completely.
    */

    if (
      EXCLUDED_CATEGORIES.has(
        String(
          item.categorySlug || ""
        ).toLowerCase()
      )
    ) {
      continue;
    }


    const price =
      getSinglePrice(
        item
      );


    if (
      price == null ||
      price < 1000
    ) {
      continue;
    }


    const volume7d =
      Number(
        item?.ah
          ?.single
          ?.volume || 0
      );


    if (
      volume7d < 14
    ) {
      continue;
    }


    const liquidity =
      getLiquidityInfo(
        item,
        1
      );


    if (
      liquidity.saturated
    ) {
      continue;
    }


    if (
      liquidity.lastSaleAgeDays != null &&
      liquidity.lastSaleAgeDays > 7
    ) {
      continue;
    }


    const marketPotential =
      price *
      liquidity.salesPerDay;


    candidates.push({

      item,

      salePrice:
        price,

      liquidity,

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


    const result = {

      ok: true,
      data
    };


    craftCache.set(
      id,
      result
    );


    return result;

  } catch (error) {


    const result = {

      ok: false,

      error:
        error.message
    };


    craftCache.set(
      id,
      result
    );


    return result;
  }
}


/* =========================================================
   RECIPE PARSER
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

        if (
          entry?.recipe
        ) {

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
      x =>
        x.recipe
    );
}


/* =========================================================
   MATERIAL COST
========================================================= */

function calculateMaterials(
  recipe,
  marketItems
) {

  const materials =
    [];

  let materialCost =
    0;

  let missingPrice =
    false;


  if (
    recipe?.crystal?.name
  ) {

    const item =

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
        item
      );


    const total =
      pricing.selectedUnitPrice;


    if (
      total == null
    ) {

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

      qty:
        1,

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
        total != null
          ? Number(
              total.toFixed(2)
            )
          : null
    });
  }


  for (
    const ingredient
    of recipe?.ingredients || []
  ) {

    const item =

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
        item
      );


    const qty =
      Number(
        ingredient.qty || 1
      );


    const total =
      pricing.selectedUnitPrice != null
        ? pricing.selectedUnitPrice *
          qty
        : null;


    if (
      total == null
    ) {

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
        total != null
          ? Number(
              total.toFixed(2)
            )
          : null
    });
  }


  return {

    missingPrice,

    materialCost:
      missingPrice
        ? null
        : Number(
            materialCost.toFixed(2)
          ),

    materials
  };
}


/* =========================================================
   ANALYZE RECIPE
========================================================= */

function analyzeRecipe(
  outputItem,
  recipeEntry,
  marketItems
) {

  /*
    Safety:
    exclude automation here too,
    even if somehow it reached this point.
  */

  if (
    EXCLUDED_CATEGORIES.has(
      String(
        outputItem.categorySlug || ""
      ).toLowerCase()
    )
  ) {

    return {

      excluded: true,

      exclusionReason:
        "excluded-category"
    };
  }


  const recipe =
    recipeEntry.recipe;


  const actualResultId =
    Number(
      recipe?.result?.id
    );


  const requestedOutputId =
    Number(
      outputItem.itemId
    );


  /*
    HQ result safety:
    don't treat HQ output as guaranteed.
  */

  if (
    actualResultId !==
    requestedOutputId
  ) {

    return {

      excluded: true,

      exclusionReason:
        "indirect-hq-result"
    };
  }


  const salePrice =
    getSinglePrice(
      outputItem
    );


  if (
    salePrice == null
  ) {

    return {

      excluded: true,

      exclusionReason:
        "no-sale-price"
    };
  }


  const outputQty =
    Number(
      recipe?.result?.qty || 1
    );


  const saleRevenue =
    salePrice *
    outputQty;


  const costs =
    calculateMaterials(
      recipe,
      marketItems
    );


  if (
    costs.missingPrice ||
    costs.materialCost == null
  ) {

    return {

      excluded: true,

      exclusionReason:
        "missing-material-price"
    };
  }


  const grossProfit =
    Number(
      (
        saleRevenue -
        costs.materialCost
      ).toFixed(2)
    );


  if (
    grossProfit <= 0
  ) {

    return {

      excluded: true,

      exclusionReason:
        "not-profitable"
    };
  }


  const marginPct =
    costs.materialCost > 0
      ? Number(
          (
            grossProfit /
            costs.materialCost *
            100
          ).toFixed(2)
        )
      : null;


  const liquidity =
    getLiquidityInfo(
      outputItem,
      outputQty
    );


  if (
    !liquidity.top20Eligible
  ) {

    return {

      excluded: true,

      exclusionReason:
        "too-slow-or-saturated"
    };
  }


  const batchDays =
    Math.max(
      liquidity
        .daysToSellCraftBatch || 0.25,
      0.25
    );


  const profitPerSellDay =
    Number(
      (
        grossProfit /
        batchDays
      ).toFixed(2)
    );


  const profitScore =
    Math.min(
      grossProfit /
      1000,
      100
    );


  const speedScore =
    Math.min(
      liquidity.salesPerDay *
      8,
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


  const profitDayScore =
    Math.min(
      profitPerSellDay /
      5000,
      100
    );


  let saturationScore =
    100;


  if (
    liquidity.daysToClearAfterCraft != null
  ) {

    saturationScore =
      Math.max(
        0,
        100 -
        (
          liquidity.daysToClearAfterCraft /
          14 *
          100
        )
      );
  }


  const score =
    Number(
      (
        profitScore * 0.35 +

        speedScore * 0.25 +

        marginScore * 0.15 +

        profitDayScore * 0.15 +

        saturationScore * 0.10
      ).toFixed(2)
    );


  return {

    excluded:
      false,

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

    saleMode:
      "single",

    salePriceEach:
      salePrice,

    saleRevenue,

    materialCost:
      costs.materialCost,

    profit:
      grossProfit,

    profitPerSellDay,

    marginPct,

    volume7d:
      liquidity.volume7d,

    salesPerDay:
      liquidity.salesPerDay,

    currentStock:
      liquidity.stock,

    daysToClearMarket:
      liquidity.daysToClearMarket,

    daysToSellCraftBatch:
      liquidity.daysToSellCraftBatch,

    daysToClearAfterCraft:
      liquidity.daysToClearAfterCraft,

    liquidity:
      liquidity.liquidity,

    lastSaleAgeDays:
      liquidity.lastSaleAgeDays,

    score,

    asOf:
      outputItem.asOf,

    materials:
      costs.materials,

    tiers:
      recipeEntry.tiers
  };
}


/* =========================================================
   TOP 20 SCAN
========================================================= */

async function runTop20Scan() {

  const now =
    Date.now();


  if (
    top20Cache &&
    now - top20CacheTime <
      TOP20_SCAN_COOLDOWN_MS
  ) {

    return {

      ...top20Cache,

      cachedResponse:
        true,

      secondsUntilNextExpansion:
        Math.ceil(
          (
            TOP20_SCAN_COOLDOWN_MS -
            (
              now -
              top20CacheTime
            )
          ) /
          1000
        )
    };
  }


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


  const valid =
    [];


  const excludedStats = {

    excludedCategory:
      0,

    indirectHQ:
      0,

    unprofitable:
      0,

    slowOrSaturated:
      0,

    missingMaterialPrice:
      0,

    other:
      0
  };


  function processAnalysis(
    analysis
  ) {

    if (!analysis) {
      return;
    }


    if (
      !analysis.excluded
    ) {

      valid.push(
        analysis
      );

      return;
    }


    switch (
      analysis.exclusionReason
    ) {

      case "excluded-category":

        excludedStats
          .excludedCategory++;

        break;


      case "indirect-hq-result":

        excludedStats
          .indirectHQ++;

        break;


      case "not-profitable":

        excludedStats
          .unprofitable++;

        break;


      case "too-slow-or-saturated":

        excludedStats
          .slowOrSaturated++;

        break;


      case "missing-material-price":

        excludedStats
          .missingMaterialPrice++;

        break;


      default:

        excludedStats
          .other++;
    }
  }


  /*
    Reuse everything already cached.
  */

  for (
    const candidate
    of candidates
  ) {

    const id =
      Number(
        candidate.item.itemId
      );


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
      const recipeEntry
      of recipes
    ) {

      processAnalysis(
        analyzeRecipe(
          candidate.item,
          recipeEntry,
          marketItems
        )
      );
    }
  }


  /*
    10 new craft API calls per expansion.
  */

  const MAX_NEW_CALLS =
    10;


  let newCalls =
    0;


  const scannedThisRun =
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


    scannedThisRun.push(
      candidate.item.itemName
    );


    const craftResult =
      await getCraftData(
        id
      );


    if (
      !craftResult.ok
    ) {
      continue;
    }


    const recipes =
      extractRecipes(
        craftResult.data
      );


    for (
      const recipeEntry
      of recipes
    ) {

      processAnalysis(
        analyzeRecipe(
          candidate.item,
          recipeEntry,
          marketItems
        )
      );
    }
  }


  const dedupe =
    new Map();


  for (
    const result
    of valid
  ) {

    const key =
      `${result.itemId}:${result.recipeId}`;


    const previous =
      dedupe.get(key);


    if (
      !previous ||
      result.score >
      previous.score
    ) {

      dedupe.set(
        key,
        result
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
        b.score !==
        a.score
      ) {

        return (
          b.score -
          a.score
        );
      }


      if (
        b.profitPerSellDay !==
        a.profitPerSellDay
      ) {

        return (
          b.profitPerSellDay -
          a.profitPerSellDay
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


  const response = {

    generatedAt:
      new Date()
        .toISOString(),

    marketItemCount:
      marketItems.length,

    candidateCount:
      candidates.length,

    craftCacheCount:
      craftCache.size,

    newCraftRequestsThisScan:
      newCalls,

    scannedThisRun,

    validOpportunities:
      ranked.length,

    excludedStats,

    excludedCategories:
      Array.from(
        EXCLUDED_CATEGORIES
      ),

    rules: {

      minimumSingleSales7d:
        14,

      maxExistingMarketDays:
        14,

      maxCraftBatchSellDays:
        7,

      maxMarketDaysAfterCraft:
        14,

      maxLastSaleAgeDays:
        7,

      guaranteedNQOnly:
        true,

      indirectHQExcluded:
        true,

      automationExcluded:
        true,

      unknownStackSizeUsesSingle:
        true
    },

    top20
  };


  top20Cache =
    response;

  top20CacheTime =
    Date.now();


  return {

    ...response,

    cachedResponse:
      false
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


app.get(
  "/api/top20",
  async (req, res) => {

    try {

      const result =
        await runTop20Scan();


      res.json(
        result
      );

    } catch (error) {

      res
        .status(500)
        .json({

          error:
            error.message
        });
    }
  }
);


app.get(
  "/api/debug-item",
  async (req, res) => {

    try {

      const search =
        String(
          req.query.search || ""
        ).trim();


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


      const craft =
        await getCraftData(
          item.itemId
        );


      res.json({

        market:
          item,

        excludedByCategory:
          EXCLUDED_CATEGORIES.has(
            String(
              item.categorySlug || ""
            ).toLowerCase()
          ),

        craft
      });

    } catch (error) {

      res
        .status(500)
        .json({

          error:
            error.message
        });
    }
  }
);


app.listen(
  PORT,
  () => {

    console.log(
      `HorizonXI Profit Scanner v2.1 running on ${PORT}`
    );
  }
);
