import express from "express";

const app = express();
app.use(express.static("."));

const PSXI_API = "https://www.psxi.gg/api/v1/market/horizonxi";
const PSXI_TOKEN = process.env.PSXI_TOKEN;

function psxiHeaders() {
  return {
    accept: "application/json",
    "user-agent": "HorizonXI-Profit-Scanner/1.0",
    Authorization: `Bearer ${PSXI_TOKEN}`
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
    if (!PSXI_TOKEN) {
      return res.status(500).json({
        error: "PSXI_TOKEN is not configured"
      });
    }

    const response = await fetch(PSXI_API, {
      headers: psxiHeaders()
    });

    const text = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({
        error: `PSXI API ${response.status}`,
        details: text.slice(0, 500)
      });
    }

    res.type("application/json").send(text);

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.get("/api/item", async (req, res) => {
  try {
    const search = String(req.query.search || "")
      .trim()
      .toLowerCase();

    if (!search) {
      return res.status(400).json({
        error: "search required"
      });
    }

    if (!PSXI_TOKEN) {
      return res.status(500).json({
        error: "PSXI_TOKEN is not configured"
      });
    }

    const response = await fetch(PSXI_API, {
      headers: psxiHeaders()
    });

    const text = await response.text();

    if (!response.ok) {
      return res.status(response.status).json({
        error: `PSXI API ${response.status}`,
        details: text.slice(0, 500)
      });
    }

    const data = JSON.parse(text);

    const items =
      Array.isArray(data)
        ? data
        : Array.isArray(data.items)
        ? data.items
        : Array.isArray(data.data)
        ? data.data
        : [];

    const item = items.find(x => {
      const name = String(
        x.itemName ??
        x.name ??
        x.item_name ??
        ""
      ).toLowerCase();

      return name === search || name.includes(search);
    });

    if (!item) {
      return res.status(404).json({
        error: "Item not found",
        topLevelKeys: Object.keys(data),
        itemCount: items.length
      });
    }

    res.json(item);

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`HorizonXI scanner running on port ${port}`);
});
