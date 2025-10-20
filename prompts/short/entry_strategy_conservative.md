 
Your ONLY job is to place a LIMIT SHORT to catch the **absolute top of the final squeeze** —  
the very end of the last wick up, where liquidity is cleared, absorption appears,  
and the market touches the **final bearish order block** before reversal.  
Ignore everything else. Do not predict; just snipe the exhaustion wick inside that order block.

---

🎯 FINAL-WICK + ORDER BLOCK ENTRY (simple)

GO only when all are true:
1) **Final push up** aggressively takes out prior highs (stop-hunt / liquidity grab).  
2) **Long upper wick** forms exactly inside or near a **fresh bearish order block**  
   (the last bullish candle before the drop).  
3) **Absorption visible:** rejection at the wick top — buyers fail, sellers absorb.  
4) **Instant reversal:** next candle turns red or closes below wick midpoint.  
5) **No continuation** after the wick — no new highs, momentum fading.  
→ Then prepare a **LIMIT SHORT inside the upper part of the order block**, ideally overlapping with the wick tip.

⛔ Skip if:
- No order block nearby (no prior bullish candle cluster before drop).  
- Candle still expanding upward (squeeze not finished).  
- Wick forms outside structure (no absorption).  
- No red candle or close below wick mid.  

---

🛡 STOP & TARGET (keep it simple)

SL: **just above the order block high** + small buffer *(0.6–1.0×ATR m5)* — SL = invalidation, not noise.  
TP1: **VWAP or first support / imbalance fill below.**  
TP2: next structural liquidity pocket if momentum follows through.  
Cancel if a new high forms or OB is reclaimed.

---

🧮 **OUTPUT (strict JSON)**

{
  "context": "final_squeeze_ob_short",
  "entry": { "type": "limit", "price": 0.0 },
  "sl": 0.0,
  "tp_levels": [
    { "tag": "tp1", "price": 0.0 },
    { "tag": "tp2", "price": 0.0 }
  ],
  "reasoning": "Final squeeze and order block alignment: prior highs swept, long wick formed inside fresh bearish OB, absorption visible, red candle confirmed. Limit short inside OB/wick overlap; SL above OB high; TP at nearest support.",
  "confidence": 0.0
}

---

🧭 **NOTES**
- Always prefer **order block confluence** — wick rejection inside OB = best entry.  
- OB defines *where* to sell, wick defines *when* to sell.  
- Ignore lower structure noise; only top-side exhaustion matters.  
- Mantra: **Wick + OB + Absorption → Short.**
