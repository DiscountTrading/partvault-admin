import { useState, useEffect } from 'react'
import { C, S, APP_VERSION } from '../lib/constants'
import { sb } from '../lib/supabase'

const DEFAULT_FOOTER = `At Cloud9 Auto Parts, we aim to make your buying experience as simple and reliable as possible. All photos shown are of the exact part you will receive, no stock images. We clearly list the compatible models and year ranges in each title, but we always recommend double checking fitment by comparing photos, part numbers, and your own research.
All parts are genuine used OEM components unless stated otherwise. As they are pre-owned, some items may show minor wear, which we highlight clearly in the photos. Everything we have in stock is listed here on our eBay store.
Some parts, such as ECUs or stereos, may require a security code from the vehicle manufacturer. Steering wheels are sold without airbags due to shipping restrictions.
Shipping:
All items are posted first thing each morning. Orders placed after the daily dispatch time will be shipped the following morning, and tracking will be provided through eBay once your order is on its way.
Please note that we do not offer local pickup.
If you have any questions, feel free to send a message. I'll always do my best to help and ensure you're completely satisfied with your purchase.`

const DEFAULT_AI_SETTINGS = {
  includeMake: true,
  includeModel: true,
  includeSeries: true,
  includeYearRange: true,
  descriptionLength: 'medium',
  includeInstallLink: false,
  installLinkUrl: '',
  includePartNumber: true,
  includeConditionDetail: true,
  customPromptNotes: '',
}

const DESCRIPTION_LENGTH_OPTIONS = [
  { value: 'short', label: 'Short', desc: '2–3 sentences, key facts only' },
  { value: 'medium', label: 'Medium', desc: '1–2 paragraphs, good detail' },
  { value: 'long', label: 'Long', desc: 'Full description with all details' },
]

function Section({ title, children }) {
  return (
    <div style={{ ...S.card, marginBottom: 16 }}>
      <h2 style={S.h2}>{title}</h2>
      {children}
    </div>
  )
}

function Toggle({ label, desc, value, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0', borderBottom: `1px solid ${C.border}` }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{label}</div>
        {desc && <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{desc}</div>}
      </div>
      <button
        onClick={() => onChange(!value)}
        style={{
          width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer',
          background: value ? C.accent : C.border, position: 'relative', transition: 'background .2s', flexShrink: 0, marginLeft: 16
        }}
      >
        <span style={{
          position: 'absolute', top: 3, left: value ? 22 : 3,
          width: 18, height: 18, borderRadius: '50%', background: '#fff',
          transition: 'left .2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
        }} />
      </button>
    </div>
  )
}

export default function Settings({ profile, storeId, onSignOut }) {
  const [tab, setTab] = useState('account')
  const [footer, setFooter] = useState(DEFAULT_FOOTER)
  const [aiSettings, setAiSettings] = useState(DEFAULT_AI_SETTINGS)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loading, setLoading] = useState(true)
  const [previewOpen, setPreviewOpen] = useState(false)

  useEffect(() => {
    loadSettings()
  }, [storeId])

  const loadSettings = async () => {
    if (!storeId) return
    try {
      const { data } = await sb.from('stores').select('settings').eq('id', storeId).single()
      if (data?.settings) {
        if (data.settings.footer) setFooter(data.settings.footer)
        if (data.settings.aiDescription) setAiSettings(s => ({ ...s, ...data.settings.aiDescription }))
      }
    } catch (e) {
      console.error('Failed to load settings', e)
    }
    setLoading(false)
  }

  const saveSettings = async () => {
    if (!storeId) return
    setSaving(true)
    try {
      const current = await sb.from('stores').select('settings').eq('id', storeId).single()
      const merged = { ...(current.data?.settings || {}), footer, aiDescription: aiSettings }
      await sb.from('stores').update({ settings: merged }).eq('id', storeId)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      console.error('Save failed', e)
    }
    setSaving(false)
  }

  const setAi = (k, v) => setAiSettings(s => ({ ...s, [k]: v }))

  const previewDescription = () => {
    const parts = []
    if (aiSettings.includeMake) parts.push('[Make]')
    if (aiSettings.includeModel) parts.push('[Model]')
    if (aiSettings.includeSeries) parts.push('[Series/Badge]')
    const yearRange = aiSettings.includeYearRange ? 'Suits [XXXX]–[XXXX] models (AI-determined)' : ''
    const partDesc = {
      short: 'Genuine OEM [Part Name] in [Condition] condition.',
      medium: 'Genuine OEM [Part Name] removed from a [Year] [Make] [Model]. Part is in [Condition] condition with [minor/no] visible wear. All photos are of the actual item.',
      long: 'Genuine OEM [Part Name] removed from a [Year] [Make] [Model] [Series]. This part is in [Condition] condition. [Detail about wear/function]. Part number: [OEM#]. All photos are of the exact item you will receive — no stock images used.',
    }[aiSettings.descriptionLength]

    let preview = `${partDesc}\n\n`
    if (yearRange) preview += `${yearRange}\n\n`
    if (aiSettings.includePartNumber) preview += `OEM Part Number: [Part Number]\n\n`
    if (aiSettings.includeInstallLink && aiSettings.installLinkUrl) {
      preview += `Installation guide: ${aiSettings.installLinkUrl}\nDisclaimer: We recommend all parts are installed by a qualified mechanic.\n\n`
    }
    preview += '---\n\n' + footer
    return preview
  }

  const SETTING_TABS = [
    { id: 'account', label: '👤 Account' },
    { id: 'descriptions', label: '📝 Descriptions' },
    { id: 'ebay', label: '🛒 eBay Sync' },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, paddingBottom: 16, borderBottom: `1px solid ${C.border}` }}>
        <h2 style={S.h1}>⚙️ Settings</h2>
        {(tab === 'descriptions') && (
          <button
            style={{ ...S.btn(), opacity: saving ? 0.6 : 1 }}
            onClick={saveSettings}
            disabled={saving}
          >
            {saving ? 'Saving...' : saved ? '✓ Saved' : 'Save Settings'}
          </button>
        )}
      </div>

      {/* Sub-tabs */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 20, borderBottom: `2px solid ${C.border}`, paddingBottom: 0 }}>
        {SETTING_TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '8px 18px', fontSize: 13, fontWeight: tab === t.id ? 700 : 500,
              color: tab === t.id ? C.accent : C.muted,
              borderBottom: tab === t.id ? `2px solid ${C.accent}` : '2px solid transparent',
              marginBottom: -2, transition: 'all .15s'
            }}
          >{t.label}</button>
        ))}
      </div>

      {/* ACCOUNT TAB */}
      {tab === 'account' && (
        <>
          <Section title="Account">
            <div style={{ fontSize: 14, color: C.muted, lineHeight: 1.9, marginBottom: 16 }}>
              <div>Logged in as: <strong style={{ color: C.text }}>{profile?.name || profile?.email || '—'}</strong></div>
              <div>Role: <strong style={{ color: C.text }}>{profile?.role || '—'}</strong></div>
              <div>Store: <strong style={{ color: C.text }}>{profile?.store?.name || '—'}</strong></div>
            </div>
            <button style={{ ...S.btn('danger'), padding: '10px 24px' }} onClick={onSignOut}>Sign Out</button>
          </Section>
          <Section title="Supabase Connection">
            <div style={{ fontSize: 14, color: C.muted, lineHeight: 1.9 }}>
              <div style={{ color: C.green }}>● Real-time sync active</div>
              <div>Changes from the mobile app appear instantly.</div>
            </div>
          </Section>
          <div style={{ ...S.card }}>
            <div style={{ fontSize: 12, color: C.muted }}>PartVault Admin v{APP_VERSION}</div>
          </div>
        </>
      )}

      {/* DESCRIPTIONS TAB */}
      {tab === 'descriptions' && !loading && (
        <>
          <Section title="🤖 AI Description Template">
            <p style={{ fontSize: 13, color: C.muted, marginBottom: 16, lineHeight: 1.6 }}>
              Configure what information the AI includes when generating part descriptions. The AI will attempt to determine the correct year range compatibility — this is editable after generation.
            </p>

            <div style={{ marginBottom: 20 }}>
              <label style={S.label}>Description Length</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {DESCRIPTION_LENGTH_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setAi('descriptionLength', opt.value)}
                    style={{
                      flex: 1, padding: '10px 8px', borderRadius: 8, cursor: 'pointer', textAlign: 'center',
                      border: `2px solid ${aiSettings.descriptionLength === opt.value ? C.accent : C.border}`,
                      background: aiSettings.descriptionLength === opt.value ? C.accent + '15' : '#fff',
                      color: aiSettings.descriptionLength === opt.value ? C.accent : C.text,
                    }}
                  >
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{opt.label}</div>
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>{opt.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            <Toggle label="Include Make" value={aiSettings.includeMake} onChange={v => setAi('includeMake', v)} />
            <Toggle label="Include Model" value={aiSettings.includeModel} onChange={v => setAi('includeModel', v)} />
            <Toggle label="Include Series/Badge" desc="e.g. GLX, Sport, Executive" value={aiSettings.includeSeries} onChange={v => setAi('includeSeries', v)} />
            <Toggle
              label="Include Year Range Compatibility"
              desc="AI determines which years this part suits — not just the donor car year. Critical for sales."
              value={aiSettings.includeYearRange}
              onChange={v => setAi('includeYearRange', v)}
            />
            <Toggle label="Include OEM Part Number" value={aiSettings.includePartNumber} onChange={v => setAi('includePartNumber', v)} />
            <Toggle label="Include Condition Detail" desc="Describes visible wear based on condition field" value={aiSettings.includeConditionDetail} onChange={v => setAi('includeConditionDetail', v)} />
            <Toggle
              label="Include Installation Guide Link"
              desc="Adds a link with disclaimer recommending professional installation"
              value={aiSettings.includeInstallLink}
              onChange={v => setAi('includeInstallLink', v)}
            />

            {aiSettings.includeInstallLink && (
              <div style={{ marginTop: 12 }}>
                <label style={S.label}>Installation Guide URL</label>
                <input
                  style={S.input}
                  placeholder="https://..."
                  value={aiSettings.installLinkUrl}
                  onChange={e => setAi('installLinkUrl', e.target.value)}
                />
              </div>
            )}

            <div style={{ marginTop: 16 }}>
              <label style={S.label}>Additional Notes for AI (optional)</label>
              <textarea
                style={{ ...S.textarea, minHeight: 70 }}
                placeholder="e.g. Always mention free returns. Avoid using the word 'used' — say 'pre-owned' instead."
                value={aiSettings.customPromptNotes}
                onChange={e => setAi('customPromptNotes', e.target.value)}
              />
            </div>
          </Section>

          <Section title="📄 Standard Footer">
            <p style={{ fontSize: 13, color: C.muted, marginBottom: 12, lineHeight: 1.6 }}>
              This text is appended to every listing description below the AI-generated content. Edit it to match your store's policies and tone.
            </p>
            <textarea
              style={{ ...S.textarea, minHeight: 240, fontFamily: 'inherit', fontSize: 13, lineHeight: 1.7 }}
              value={footer}
              onChange={e => setFooter(e.target.value)}
            />
          </Section>

          <Section title="👁 Description Preview">
            <p style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>
              This is how a generated listing will look with your current settings. Placeholders shown in [brackets] will be filled in by AI.
            </p>
            <div style={{
              background: '#f9f8f5', border: `1px solid ${C.border}`, borderRadius: 8,
              padding: 16, fontSize: 13, lineHeight: 1.8, whiteSpace: 'pre-wrap',
              color: C.text, fontFamily: 'inherit', maxHeight: 400, overflowY: 'auto'
            }}>
              {previewDescription()}
            </div>
          </Section>
        </>
      )}

      {/* EBAY SYNC TAB */}
      {tab === 'ebay' && (
        <Section title="🛒 eBay Sync">
          <div style={{ background: '#fffbeb', border: `1px solid #fde68a`, borderRadius: 8, padding: 16, marginBottom: 20 }}>
            <div style={{ fontWeight: 700, color: '#92400e', marginBottom: 6 }}>⚠️ Read-Only Mode</div>
            <div style={{ fontSize: 13, color: '#78350f', lineHeight: 1.6 }}>
              eBay sync is currently read-only. You can compare PartVault inventory against your live eBay listings and download data, but all eBay changes must be made via CSV upload or directly in eBay Seller Hub. Write access will be added in a future update with appropriate disclaimers.
            </div>
          </div>
          <div style={{ fontSize: 14, color: C.muted, marginBottom: 20, lineHeight: 1.7 }}>
            <div style={{ marginBottom: 8 }}>To enable eBay sync you'll need an eBay Developer account:</div>
            <ol style={{ paddingLeft: 20, lineHeight: 2 }}>
              <li>Register at <strong>developer.ebay.com</strong> once your business name is confirmed</li>
              <li>Create an application and obtain your App ID, Cert ID, and OAuth token</li>
              <li>Enter credentials here to activate read sync</li>
            </ol>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            <div>
              <label style={S.label}>App ID (Client ID)</label>
              <input style={{ ...S.input, opacity: 0.5 }} placeholder="Not yet configured" disabled />
            </div>
            <div>
              <label style={S.label}>Cert ID (Client Secret)</label>
              <input style={{ ...S.input, opacity: 0.5 }} placeholder="Not yet configured" disabled />
            </div>
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={S.label}>OAuth User Token</label>
            <input style={{ ...S.input, opacity: 0.5 }} placeholder="Not yet configured" disabled />
          </div>
          <button style={{ ...S.btn('secondary'), opacity: 0.5 }} disabled>Connect eBay (Coming Soon)</button>
        </Section>
      )}
    </div>
  )
}
