import express from "express";

const app = express();
app.use(express.static("."));

const PORT = process.env.PORT || 3000;
const PSXI_TOKEN = process.env.PSXI_TOKEN;

const MARKET_URL =
  "https://www.psxi.gg/api/v1/market/horizonxi";

const CRAFT_URL = (id) =>
  `https://www.psxi.gg/api/v1/craft/horizonxi/item/${id}`;

const MARKET_TTL =
  10 * 60 * 1000;

const EXPAND_COOLDOWN =
  2 * 60 * 1000;

const NEW_CRAFT_CALLS_PER_EXPANSION =
  10;

const PSXI_TIMEOUT_MS =
  8000;

let marketCache = null;
let marketAt = 0;
let lastExpansionAt = 0;

const craftCache =
  new Map();

const EXCLUDED_CATEGORIES =
  new Set([
    "automation",
    "automatom"
  ]);


/* =========================================================
   VERIFIED STACK SIZES
========================================================= */

const STACK_SIZE = {

  4096: 12,
  4097: 12,
  4098: 12,
  4099: 12,

  4100: 12,
  4101: 12,
  4102: 12,
  4103: 12,

  719: 12,
  1300: 12
};


/* =========================================================
   PSXI
========================================================= */

function apiHeaders() {

  return {

    accept:
      "application/json",

    "user-agent":
      "HorizonXI-Profit-Scanner/3.1",

    Authorization:
      `Bearer ${PSXI_TOKEN}`
  };
}


async function api(url) {

  if (!PSXI_TOKEN) {

    throw new Error(
      "PSXI_TOKEN is not configured"
    );
  }


  const controller =
    new AbortController();


  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      PSXI_TIMEOUT_MS
    );


  try {

    const response =
      await fetch(
        url,
        {
          headers:
            apiHeaders(),

          signal:
            controller.signal
        }
      );


    const text =
      await response.text();


    if (!response.ok) {

      const error =
        new Error(
          `PSXI ${response.status}: ${text.slice(0, 250)}`
        );

      error.status =
        response.status;

      throw error;
    }


    return JSON.parse(
      text
    );


  } catch (error) {

    if (
      error.name ===
      "AbortError"
    ) {

      throw new Error(
        "PSXI request timed out"
      );
    }


    throw error;


  } finally {

    clearTimeout(
      timeout
    );
  }
}


/* =========================================================
   MARKET
========================================================= */

async function getMarket() {

  if (
    marketCache &&
    Date.now() -
      marketAt <
      MARKET_TTL
  ) {

    return marketCache;
  }


  marketCache =
    await api(
      MARKET_URL
    );


  marketAt =
    Date.now();


  return marketCache;
}


function itemsOf(
  market
) {

  if (
    Array.isArray(
      market
    )
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
   ITEM HELPERS
========================================================= */

function nameKey(
  value
) {

  return String(
    value || ""
  )
    .trim()
    .toLowerCase();
}


function byId(
  items,
  id
) {

  return (
    items.find(
      item =>
        Number(
          item.itemId
        ) ===
        Number(id)
    ) || null
  );
}


function byName(
  items,
  name
) {

  const query =
    nameKey(
      name
    );


  return (

    items.find(
      item =>
        nameKey(
          item.itemName
        ) ===
        query
    )

    ||

    items.find(
      item =>
        nameKey(
          item.itemName
        ).includes(
          query
        )
    )

    ||

    null
  );
}


function excludedCategory(
  item
) {

  return (
    EXCLUDED_CATEGORIES.has(
      nameKey(
        item?.categorySlug
      )
    )
  );
}


/* =========================================================
   MARKET PRICES
========================================================= */

function singlePrice(
  item
) {

  const single =
    item?.ah?.single || {};


  const value =

    single.lastSale ??

    single.median ??

    single.avg ??

    null;


  return (
    value == null
      ? null
      : Number(
          value
        )
  );
}


function stackPrice(
  item
) {

  const stack =
    item?.ah?.stack || {};


  const value =

    stack.lastSale ??

    stack.median ??

    stack.avg ??

    null;


  return (
    value == null
      ? null
      : Number(
          value
        )
  );
}


function hasStackMarket(
  item
) {

  const stack =
    item?.ah?.stack || {};


  return (

    stack.lastSale != null ||

    stack.median != null ||

    stack.avg != null ||

    Number(
      stack.volume || 0
    ) > 0 ||

    Number(
      item?.ah
        ?.currentStackStock ||
      0
    ) > 0
  );
}


function stackSize(
  item
) {

  return (

    STACK_SIZE[
      Number(
        item?.itemId
      )
    ]

    ?? null
  );
}


/* =========================================================
   MATERIAL PRICE
========================================================= */

function materialPrice(
  item
) {

  if (!item) {

    return {

      unit:
        null,

      mode:
        "missing",

      stackSize:
        null
    };
  }


  const single =
    singlePrice(
      item
    );


  const stack =
    stackPrice(
      item
    );


  const size =
    stackSize(
      item
    );


  let stackUnit =
    null;


  if (
    size &&
    stack != null
  ) {

    stackUnit =
      stack /
      size;
  }


  if (
    single != null &&
    stackUnit != null
  ) {

    if (
      stackUnit <
      single
    ) {

      return {

        unit:
          Number(
            stackUnit
              .toFixed(2)
          ),

        mode:
          "stack",

        singlePrice:
          single,

        stackPrice:
          stack,

        stackUnitPrice:
          Number(
            stackUnit
              .toFixed(2)
          ),

        stackSize:
          size
      };
    }


    return {

      unit:
        single,

      mode:
        "single",

      singlePrice:
        single,

      stackPrice:
        stack,

      stackUnitPrice:
        Number(
          stackUnit
            .toFixed(2)
        ),

      stackSize:
        size
    };
  }


  if (
    single != null
  ) {

    return {

      unit:
        single,

      mode:
        "single",

      singlePrice:
        single,

      stackPrice:
        stack,

      stackUnitPrice:
        stackUnit,

      stackSize:
        size
    };
  }


  if (
    stackUnit != null
  ) {

    return {

      unit:
        Number(
          stackUnit
            .toFixed(2)
        ),

      mode:
        "stack",

      singlePrice:
        single,

      stackPrice:
        stack,

      stackUnitPrice:
        Number(
          stackUnit
            .toFixed(2)
        ),

      stackSize:
        size
    };
  }


  return {

    unit:
      null,

    mode:
      "unpriced",

    singlePrice:
      single,

    stackPrice:
      stack,

    stackUnitPrice:
      stackUnit,

    stackSize:
      size
  };
}


/* =========================================================
   LIQUIDITY
========================================================= */

function lastSaleAgeDays(
  item
) {

  const raw =
    item?.ah
      ?.single
      ?.lastSaleDate;


  if (!raw) {
    return null;
  }


  const time =
    new Date(
      raw
    ).getTime();


  if (
    Number.isNaN(
      time
    )
  ) {
    return null;
  }


  return Number(
    (
      (
        Date.now() -
        time
      )
      /
      86400000
    ).toFixed(2)
  );
}


function liquidity(
  item,
  outputQty = 1
) {

  const stock =
    Number(
      item?.ah
        ?.currentStock ||
      0
    );


  const volume7d =
    Number(
      item?.ah
        ?.single
        ?.volume ||
      0
    );


  const salesPerDay =
    volume7d / 7;


  const daysToClear =
    salesPerDay > 0
      ? stock /
        salesPerDay
      : null;


  const batchDays =
    salesPerDay > 0
      ? Number(
          outputQty
        ) /
        salesPerDay
      : null;


  const afterCraftDays =
    salesPerDay > 0
      ? (
          stock +
          Number(
            outputQty
          )
        )
        /
        salesPerDay
      : null;


  return {

    stock,

    volume7d,

    salesPerDay:
      Number(
        salesPerDay
          .toFixed(2)
      ),

    daysToClear:
      daysToClear ==
      null
        ? null
        : Number(
            daysToClear
              .toFixed(2)
          ),

    batchDays:
      batchDays ==
      null
        ? null
        : Number(
            batchDays
              .toFixed(2)
          ),

    afterCraftDays:
      afterCraftDays ==
      null
        ? null
        : Number(
            afterCraftDays
              .toFixed(2)
          ),

    lastSaleAgeDays:
      lastSaleAgeDays(
        item
      ),

    eligible:

      volume7d >= 14

      &&

      salesPerDay > 0

      &&

      (
        daysToClear ==
        null

        ||

        daysToClear <=
        14
      )

      &&

      (
        batchDays ==
        null

        ||

        batchDays <=
        7
      )

      &&

      (
        afterCraftDays ==
        null

        ||

        afterCraftDays <=
        14
      )
  };
}


/* =========================================================
   CANDIDATES
========================================================= */

function candidates(
  items
) {

  return items

    .filter(
      item =>
        !excludedCategory(
          item
        )
    )

    .map(
      item => {

        const price =
          singlePrice(
            item
          );


        const liq =
          liquidity(
            item,
            1
          );


        return {

          item,

          price,

          liq,

          potential:
            price == null
              ? 0
              : price *
                liq.salesPerDay
        };
      }
    )

    .filter(
      x =>

        x.price != null

        &&

        x.price >= 1000

        &&

        x.liq.volume7d >=
        14

        &&

        (
          x.liq.daysToClear ==
          null

          ||

          x.liq.daysToClear <=
          14
        )

        &&

        (
          x.liq
            .lastSaleAgeDays ==
          null

          ||

          x.liq
            .lastSaleAgeDays <=
          7
        )
    )

    .sort(
      (a, b) =>
        b.potential -
        a.potential
    );
}


/* =========================================================
   CRAFT CACHE
========================================================= */

async function fetchCraft(
  id
) {

  id =
    Number(
      id
    );


  if (
    craftCache.has(
      id
    )
  ) {

    return craftCache.get(
      id
    );
  }


  try {

    const data =
      await api(
        CRAFT_URL(
          id
        )
      );


    const value = {

      ok:
        true,

      data
    };


    craftCache.set(
      id,
      value
    );


    return value;


  } catch (error) {

    /*
      لا نخزن timeout / rate-limit
      كفشل دائم.
    */

    const message =
      String(
        error.message || ""
      );


    if (
      message.includes(
        "timed out"
      )

      ||

      message.includes(
        "PSXI 429"
      )
    ) {

      return {

        ok:
          false,

        temporary:
          true,

        error:
          message
      };
    }


    const value = {

      ok:
        false,

      error:
        message
    };


    craftCache.set(
      id,
      value
    );


    return value;
  }
}


/* =========================================================
   RECIPES
========================================================= */

function recipesOf(
  craftData
) {

  if (
    !Array.isArray(
      craftData?.recipes
    )
  ) {

    return [];
  }


  return craftData
    .recipes

    .map(
      entry => ({

        recipe:
          entry?.recipe ||
          entry,

        tiers:
          Array.isArray(
            entry?.tiers
          )
            ? entry.tiers
            : []
      })
    )

    .filter(
      x =>
        x.recipe
    );
}


/* =========================================================
   MATERIAL COST
========================================================= */

function materialsCost(
  recipe,
  items
) {

  const materials =
    [];


  let total =
    0;


  const add =
    (
      type,
      source,
      qty
    ) => {


      const item =

        byId(
          items,
          source?.id
        )

        ||

        byName(
          items,
          source?.name
        );


      const pricing =
        materialPrice(
          item
        );


      const line =
        pricing.unit ==
        null
          ? null
          : pricing.unit *
            qty;


      materials.push({

        type,

        itemId:
          source?.id ??
          null,

        itemName:
          source?.name ??
          "",

        qty,

        purchaseMode:
          pricing.mode,

        bestUnitPrice:
          pricing.unit,

        stackSize:
          pricing.stackSize ??
          null,

        singlePrice:
          pricing.singlePrice ??
          null,

        stackPrice:
          pricing.stackPrice ??
          null,

        stackUnitPrice:
          pricing.stackUnitPrice ??
          null,

        totalCost:
          line ==
          null
            ? null
            : Number(
                line
                  .toFixed(2)
              )
      });


      if (
        line == null
      ) {

        return false;
      }


      total +=
        line;


      return true;
    };


  if (
    recipe?.crystal?.name
  ) {

    if (
      !add(
        "crystal",
        recipe.crystal,
        1
      )
    ) {

      return {

        ok:
          false,

        materials
      };
    }
  }


  for (
    const ingredient
    of recipe?.ingredients ||
    []
  ) {

    if (
      !add(
        "ingredient",
        ingredient,
        Number(
          ingredient.qty ||
          1
        )
      )
    ) {

      return {

        ok:
          false,

        materials
      };
    }
  }


  return {

    ok:
      true,

    total:
      Number(
        total
          .toFixed(2)
      ),

    materials
  };
}


/* =========================================================
   ANALYSIS
========================================================= */

function analyze(
  outputItem,
  entry,
  items
) {

  if (
    excludedCategory(
      outputItem
    )
  ) {

    return null;
  }


  const recipe =
    entry.recipe;


  /*
    HQ alternate result
    مب guaranteed.
  */

  if (
    Number(
      recipe?.result?.id
    )
    !==
    Number(
      outputItem.itemId
    )
  ) {

    return null;
  }


  const qty =
    Number(
      recipe?.result?.qty ||
      1
    );


  /*
    يمنع false positives مثل Armor Plate II.
  */

  if (
    qty > 1

    &&

    !hasStackMarket(
      outputItem
    )
  ) {

    return null;
  }


  const sell =
    singlePrice(
      outputItem
    );


  if (
    sell == null
  ) {

    return null;
  }


  const costs =
    materialsCost(
      recipe,
      items
    );


  if (
    !costs.ok
  ) {

    return null;
  }


  const revenue =
    sell *
    qty;


  const profit =
    Number(
      (
        revenue -
        costs.total
      ).toFixed(2)
    );


  if (
    profit <= 0
  ) {

    return null;
  }


  const liq =
    liquidity(
      outputItem,
      qty
    );


  if (
    !liq.eligible
  ) {

    return null;
  }


  const margin =
    costs.total > 0
      ? Number(
          (
            (
              profit /
              costs.total
            )
            *
            100
          ).toFixed(2)
        )
      : null;


  const profitPerSellDay =
    Number(
      (
        profit
        /
        Math.max(
          liq.batchDays ||
          0.25,
          0.25
        )
      ).toFixed(2)
    );


  const profitScore =
    Math.min(
      profit / 1000,
      100
    );


  const speedScore =
    Math.min(
      liq.salesPerDay *
      8,
      100
    );


  const marginScore =
    Math.min(
      Math.max(
        margin || 0,
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


  const saturationScore =
    liq.afterCraftDays ==
    null
      ? 100
      : Math.max(
          0,
          100 -
          (
            liq.afterCraftDays /
            14
          )
          *
          100
        );


  const score =
    Number(
      (
        profitScore * 0.35
        +
        speedScore * 0.25
        +
        marginScore * 0.15
        +
        profitDayScore * 0.15
        +
        saturationScore * 0.10
      ).toFixed(2)
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

    outputQty:
      qty,

    salePriceEach:
      sell,

    saleRevenue:
      revenue,

    materialCost:
      costs.total,

    profit,

    marginPct:
      margin,

    profitPerSellDay,

    volume7d:
      liq.volume7d,

    salesPerDay:
      liq.salesPerDay,

    currentStock:
      liq.stock,

    daysToClearMarket:
      liq.daysToClear,

    daysToSellCraftBatch:
      liq.batchDays,

    daysToClearAfterCraft:
      liq.afterCraftDays,

    score,

    asOf:
      outputItem.asOf,

    materials:
      costs.materials
  };
}


/* =========================================================
   EXPAND CRAFT CACHE IN PARALLEL
========================================================= */

async function expandCraftCache(
  candidateList
) {

  if (
    Date.now() -
    lastExpansionAt <
    EXPAND_COOLDOWN
  ) {

    return {

      newCalls:
        0,

      scanned:
        []
    };
  }


  const selected =
    [];


  for (
    const candidate
    of candidateList
  ) {

    if (
      selected.length >=
      NEW_CRAFT_CALLS_PER_EXPANSION
    ) {

      break;
    }


    const id =
      Number(
        candidate.item.itemId
      );


    if (
      craftCache.has(
        id
      )
    ) {

      continue;
    }


    selected.push(
      candidate
    );
  }


  lastExpansionAt =
    Date.now();


  /*
    أهم تعديل:
    الطلبات كلها بالتوازي.
  */

  await Promise.allSettled(

    selected.map(
      candidate =>
        fetchCraft(
          candidate.item.itemId
        )
    )
  );


  return {

    newCalls:
      selected.length,

    scanned:
      selected.map(
        x =>
          x.item.itemName
      )
  };
}


/* =========================================================
   TOP 20
========================================================= */

async function buildTop20() {

  const market =
    await getMarket();


  const items =
    itemsOf(
      market
    );


  const candidateList =
    candidates(
      items
    );


  const expansion =
    await expandCraftCache(
      candidateList
    );


  const results =
    [];


  for (
    const candidate
    of candidateList
  ) {

    if (
      excludedCategory(
        candidate.item
      )
    ) {

      continue;
    }


    const cached =
      craftCache.get(
        Number(
          candidate.item.itemId
        )
      );


    if (
      !cached?.ok
    ) {

      continue;
    }


    for (
      const entry
      of recipesOf(
        cached.data
      )
    ) {

      const result =
        analyze(
          candidate.item,
          entry,
          items
        );


      if (
        result
      ) {

        results.push(
          result
        );
      }
    }
  }


  const dedupe =
    new Map();


  for (
    const result
    of results
  ) {

    const key =
      `${result.itemId}:${result.recipeId}`;


    const previous =
      dedupe.get(
        key
      );


    if (
      !previous

      ||

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
    [
      ...dedupe.values()
    ]

    .filter(
      result => {

        const item =
          byId(
            items,
            result.itemId
          );


        return (
          item &&
          !excludedCategory(
            item
          )
        );
      }
    )

    .sort(
      (a, b) =>

        b.score -
        a.score

        ||

        b.profitPerSellDay -
        a.profitPerSellDay

        ||

        b.profit -
        a.profit
    );


  return {

    generatedAt:
      new Date()
        .toISOString(),

    marketItemCount:
      items.length,

    candidateCount:
      candidateList.length,

    craftCacheCount:
      craftCache.size,

    newCraftRequestsThisScan:
      expansion.newCalls,

    scannedThisRun:
      expansion.scanned,

    validOpportunities:
      ranked.length,

    excludedCategories:
      [
        ...EXCLUDED_CATEGORIES
      ],

    rules: {

      minimumSales7d:
        14,

      maxMarketDays:
        14,

      maxCraftBatchSellDays:
        7,

      maxAfterCraftDays:
        14,

      maxLastSaleAgeDays:
        7,

      indirectHQExcluded:
        true,

      suspiciousNonStackMultiYieldExcluded:
        true,

      unknownStackSizeUsesSingle:
        true
    },

    top20:
      ranked.slice(
        0,
        20
      )
  };
}


/* =========================================================
   ROUTES
========================================================= */

app.get(
  "/api/health",
  (req, res) => {

    res.json({

      ok:
        true,

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
        await buildTop20();


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

      const market =
        await getMarket();


      const items =
        itemsOf(
          market
        );


      const item =
        byName(
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

        market:
          item,

        excludedByCategory:
          excludedCategory(
            item
          ),

        craft:
          await fetchCraft(
            item.itemId
          )
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
      `HorizonXI Profit Scanner v3.1 running on ${PORT}`
    );
  }
);
