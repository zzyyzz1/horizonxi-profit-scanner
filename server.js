import express from "express";

const app = express();

app.use(express.static("."));

const PSXI_API = "https://www.psxi.gg/api/v1/market/horizonxi";

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/market", async (req, res) => {
  try {
    const response = await fetch(PSXI_API, {
      headers: {
        "accept": "application/json",
        "user-agent": "HorizonXI-Profit-Scanner/1.0"
      }
    });

    if (!response.ok) {
      throw new Error(`PSXI API ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.get("/api/item", async (req, res) => {
  try {
    const search = String(req.query.search || "").trim().toLowerCase();

    if (!search) {
      return res.status(400).json({
        error: "search required"
      });
    }

    const response = await fetch(PSXI_API, {
      headers: {
        "accept": "application/json",
        "user-agent": "HorizonXI-Profit-Scanner/1.0"
      }
    });

    if (!response.ok) {
      throw new Error(`PSXI API ${response.status}`);
    }

    const data = await response.json();

    const items = Array.isArray(data) ? data : (data.items || []);

    const item = items.find(x =>
      String(x.itemName || x.name || "")
        .toLowerCase()
        .includes(search)
    );

    if (!item) {
      return res.status(404).json({
        error: "Item not found"
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
