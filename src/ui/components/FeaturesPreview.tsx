import React from 'react'
import type { FeaturesSnapshot } from '../../../types/features'

type Props = { features: FeaturesSnapshot }

export const FeaturesPreview: React.FC<Props> = ({ features }) => {
  const rows = features.universe.slice(0, 5)
  return (
    <details style={{ marginTop: 16 }}>
      <summary>Features Preview</summary>
      <div style={{ margin: '8px 0' }}>
        <div>Breadth: {features.breadth.pct_above_EMA50_H1}%</div>
        <div>BTC flags: H1_above_VWAP={String(features.btc.flags.H1_above_VWAP)}; H4_ema50_gt_200={String(features.btc.flags.H4_ema50_gt_200)}</div>
        <div>ETH flags: H1_above_VWAP={String(features.eth.flags.H1_above_VWAP)}; H4_ema50_gt_200={String(features.eth.flags.H4_ema50_gt_200)}</div>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Symbol</th>
            <th style={{ textAlign: 'right' }}>ATR% H1</th>
            <th style={{ textAlign: 'left' }}>EMA order H1</th>
            <th style={{ textAlign: 'right' }}>RSI M15</th>
            <th style={{ textAlign: 'right' }}>VWAP rel M15</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r: any) => (
            <tr key={r.symbol}>
              <td>{r.symbol}</td>
              <td style={{ textAlign: 'right' }}>{r.atr_pct_H1 != null ? r.atr_pct_H1.toFixed(2) : '—'}</td>
              <td>{r.ema_order_H1 ?? '—'}</td>
              <td style={{ textAlign: 'right' }}>{r.RSI_M15 != null ? r.RSI_M15.toFixed(1) : '—'}</td>
              <td style={{ textAlign: 'right' }}>{r.vwap_rel_M15 != null ? r.vwap_rel_M15.toFixed(4) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}


