import { C, S } from '../lib/constants'
import HelpAssistant from './HelpAssistant'
import SupportChat from './SupportChat'

// Top-level Help tab: AI assistant + Message-us side by side.
export default function Help({ storeId }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
      <div style={S.card}>
        <h2 style={S.h2}>🤖 Ask the assistant</h2>
        <HelpAssistant storeId={storeId} />
      </div>
      <div style={S.card}>
        <h2 style={S.h2}>🆘 Message us</h2>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>A human reply, by email and here — no phone queues.</div>
        <SupportChat storeId={storeId} />
      </div>
    </div>
  )
}
