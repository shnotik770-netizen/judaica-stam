import express from "express";
import bwipjs from "bwip-js";

export const router = express.Router();

// מדבקת ברקוד לקוד שקית. type=code128 (ברירת מחדל) או type=qr — להשוואה מול מיכאל לפני שבוחרים.
router.get("/:code", async (req, res) => {
  const type = req.query.type === "qr" ? "qrcode" : "code128";
  try {
    const opts = { bcid: type, text: req.params.code, scale: 3 };
    if (type === "code128") {
      opts.height = 12;
      opts.includetext = true;
      opts.textxalign = "center";
    }
    const png = await bwipjs.toBuffer(opts);
    res.set("Content-Type", "image/png");
    res.send(png);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
