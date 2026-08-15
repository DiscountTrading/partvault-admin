import { useState, useEffect, useRef } from 'react'
import QRCode from 'qrcode'
import { sb, EDGE_FN } from '../lib/supabase'
import { C, S } from '../lib/constants'

const LAST_EMAIL_KEY = 'pv_last_email'

// Sign-in, tuned for speed: the email is remembered per device, the code flow
// is one tap for returning users, and "Sign in with your phone" lets a
// signed-in (Face-ID-locked) phone approve this computer — no typing at all.
// Sessions persist for a year in the shared .partvault.app cookie, so any of
// these is a once-per-device event, not a daily one.
export default function AuthScreen() {
  const [email, setEmail] = useState(() => { try { return localStorage.getItem(LAST_EMAIL_KEY) || '' } catch { return '' } })
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState('login')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [otp, setOtp] = useState('')
  const [creating, setCreating] = useState(false) // true = creating a new account

  // ── Phone approval flow ────────────────────────────────────────────────────
  const [phone, setPhone] = useState(null)   // { rid, code, qr } | 'expired'
  const pollRef = useRef(null)
  const stopPolling = () => { clearInterval(pollRef.current); pollRef.current = null }
  useEffect(() => () => stopPolling(), [])

  const rememberEmail = (e) => { try { localStorage.setItem(LAST_EMAIL_KEY, e) } catch { /* ignore */ } }

  const startPhoneLogin = async () => {
    setLoading(true); setErr('')
    try {
      const res = await fetch(EDGE_FN, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'phone_login_create' }),
      })
      const d = await res.json()
      if (!res.ok || d.error) throw new Error(d.error || 'Could not start phone sign-in')
      // The QR opens the field app straight onto the approval screen.
      const url = `https://app.partvault.app/approve?code=${d.code}`
      const qr = await QRCode.toDataURL(url, { width: 240, margin: 1, color: { dark: '#17150F', light: '#ffffff' } })
      setPhone({ rid: d.rid, code: d.code, qr })
      pollRef.current = setInterval(async () => {
        try {
          const r = await fetch(EDGE_FN, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'phone_login_poll', rid: d.rid }),
          })
          const p = await r.json()
          if (p.status === 'approved' && p.tokenHash) {
            stopPolling()
            const { data, error } = await sb.auth.verifyOtp({ type: 'magiclink', token_hash: p.tokenHash })
            if (error) { setErr(error.message); setPhone(null); return }
            if (data?.user?.email) rememberEmail(data.user.email)
            // Session lands in the shared cookie — the app re-renders signed in.
          } else if (p.status === 'expired' || p.status === 'claimed') {
            stopPolling(); setPhone('expired')
          }
        } catch { /* transient network hiccup — keep polling */ }
      }, 2000)
    } catch (e) { setErr(e.message) }
    setLoading(false)
  }
  const closePhoneLogin = () => { stopPolling(); setPhone(null); setErr('') }

  const sendOtp = async () => {
    if (!email) { setErr('Enter your email'); return }
    setLoading(true); setErr('')
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: creating }
    })
    if (error) setErr(error.message)
    else { setOtpSent(true); rememberEmail(email) }
    setLoading(false)
  }

  const verifyOtp = async () => {
    if (!otp || otp.length < 6) { setErr('Enter the 6-digit code'); return }
    setLoading(true); setErr('')
    const { error } = await sb.auth.verifyOtp({ email, token: otp, type: 'email' })
    if (error) setErr(error.message)
    setLoading(false)
  }

  const signIn = async () => {
    if (!email || !password) { setErr('Enter email and password'); return }
    setLoading(true); setErr('')
    const { error } = await sb.auth.signInWithPassword({ email, password })
    if (error) setErr(error.message)
    else rememberEmail(email)
    setLoading(false)
  }

  const shell = (children) => (
    <div style={{ minHeight:'100vh', background:'linear-gradient(135deg,#f5f4f0,#edeae3)', display:'flex', alignItems:'center', justifyContent:'center', padding:24 }}>
      <div style={{ maxWidth:400, width:'100%' }}>{children}</div>
    </div>
  )

  // ── Phone-approval screen ──────────────────────────────────────────────────
  if (phone) return shell(
    <>
      <div style={{ textAlign:'center', marginBottom:24 }}>
        <div style={{ fontSize:48, marginBottom:8 }}>📱</div>
        <div style={{ fontSize:26, fontWeight:800, fontFamily:"'Inter Tight',system-ui,sans-serif", color:C.text, marginBottom:8 }}>Sign in with your phone</div>
      </div>
      <div style={{ ...S.card, textAlign:'center' }}>
        {phone === 'expired' ? (
          <>
            <div style={{ fontSize:15, fontWeight:700, color:C.text, margin:'8px 0 6px' }}>That code expired</div>
            <div style={{ fontSize:13, color:C.muted, marginBottom:16 }}>Codes only live for 2 minutes.</div>
            <button style={{ ...S.btn(), width:'100%', padding:14 }} onClick={startPhoneLogin}>Get a new code</button>
          </>
        ) : (
          <>
            <img src={phone.qr} alt="Sign-in QR code" width="240" height="240" style={{ borderRadius:12, border:`1px solid ${C.border}` }} />
            <div style={{ fontSize:22, fontWeight:800, letterSpacing:3, fontFamily:'monospace', color:C.text, margin:'10px 0 2px' }}>
              {phone.code.slice(0,4)}-{phone.code.slice(4)}
            </div>
            <div style={{ fontSize:13, color:C.muted, lineHeight:1.6, margin:'10px 0 4px', textAlign:'left' }}>
              <strong>1.</strong> Point your phone's camera at the QR — it opens the PartVault app.<br />
              <strong>2.</strong> Or open the app → Settings → <em>Approve a computer sign-in</em> and type the code.<br />
              <strong>3.</strong> Tap <strong>Approve</strong>. This screen signs in by itself.
            </div>
            <div style={{ display:'inline-flex', alignItems:'center', gap:8, fontSize:12, color:C.muted, marginTop:8 }}>
              <span style={{ animation:'spin 1s linear infinite', display:'inline-block' }}>⏳</span> Waiting for your phone…
            </div>
          </>
        )}
        {err && <div style={{ fontSize:13, color:C.red, marginTop:12 }}>{err}</div>}
        <div style={{ marginTop:14 }}>
          <span style={{ color:C.muted, cursor:'pointer', fontSize:13 }} onClick={closePhoneLogin}>← Other sign-in options</span>
        </div>
      </div>
    </>
  )

  // OTP code entry screen
  if (otpSent) return shell(
    <>
      <div style={{ textAlign:'center', marginBottom:32 }}>
        <div style={{ fontSize:56, marginBottom:8 }}>📧</div>
        <div style={{ fontSize:28, fontWeight:800, fontFamily:"'Inter Tight',system-ui,sans-serif", color:C.text, marginBottom:8 }}>Check your email</div>
        <div style={{ fontSize:14, color:C.muted, lineHeight:1.7 }}>
          We sent a 6-digit code to <strong style={{color:C.text}}>{email}</strong>
        </div>
      </div>
      <div style={S.card}>
        <div style={{ marginBottom:16 }}>
          <label style={S.label}>6-digit code</label>
          <input
            style={{ ...S.input, fontSize:24, letterSpacing:8, textAlign:'center', fontWeight:700 }}
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={otp}
            onChange={e => { setOtp(e.target.value.replace(/\D/g, '')); setErr('') }}
            onKeyDown={e => e.key === 'Enter' && verifyOtp()}
            placeholder="000000"
            autoFocus
          />
        </div>
        {err && <div style={{ fontSize:13, color:C.red, marginBottom:12 }}>{err}</div>}
        <button
          style={{ ...S.btn(), width:'100%', padding:14, fontSize:15, marginBottom:12, opacity: loading ? 0.6 : 1 }}
          onClick={verifyOtp}
          disabled={loading || otp.length < 6}
        >
          {loading ? '⏳ Verifying…' : '✓ Verify Code'}
        </button>
        <div style={{ display:'flex', justifyContent:'space-between', fontSize:13 }}>
          <span style={{ color:C.accent, cursor:'pointer', fontWeight:600 }} onClick={() => { setOtpSent(false); setOtp(''); setErr('') }}>← Back</span>
          <span style={{ color:C.accent, cursor:'pointer', fontWeight:600 }} onClick={sendOtp}>Resend code</span>
        </div>
      </div>
    </>
  )

  return shell(
    <>
      <div style={{ textAlign:'center', marginBottom:32 }}>
        <div style={{ fontSize:56, marginBottom:8 }}>⚙</div>
        <div style={{ fontSize:32, fontWeight:800, fontFamily:"'Inter Tight',system-ui,sans-serif", color:C.accent, letterSpacing:-1 }}>PartVault Admin</div>
        <div style={{ fontSize:14, color:C.muted, marginTop:6 }}>Australian Car Parts Manager</div>
      </div>
      <div style={S.card}>
        <div style={{ marginBottom:16 }}>
          <label style={S.label}>Email</label>
          <input
            style={S.input}
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && sendOtp()}
            placeholder="your@email.com"
            autoFocus={!email}
          />
        </div>
        {err && !mode.includes('password') && <div style={{ fontSize:13, color:C.red, marginBottom:12 }}>{err}</div>}
        <button
          style={{ ...S.btn(), width:'100%', padding:14, fontSize:15, marginBottom:10, opacity: loading ? 0.6 : 1 }}
          onClick={sendOtp}
          disabled={loading}
        >
          {loading ? '⏳ Sending…' : creating ? '✨ Create Account' : '✉️ Send Login Code'}
        </button>
        <button
          style={{ ...S.btn('secondary'), width:'100%', padding:13, fontSize:14, marginBottom:10 }}
          onClick={startPhoneLogin}
          disabled={loading}
          title="Approve this computer from the PartVault app on your phone — Face ID, no typing"
        >
          📱 Sign in with your phone
        </button>
        <div style={{ textAlign:'center', fontSize:13, marginBottom:16 }}>
          <span style={{ color:C.accent, cursor:'pointer', fontWeight:600 }} onClick={() => { setCreating(c => !c); setErr('') }}>
            {creating ? '← I already have an account' : 'First time? Create an account'}
          </span>
        </div>
        <div style={{ textAlign:'center', fontSize:12, color:C.muted, marginBottom:16 }}>— or sign in with password —</div>
        {mode === 'password' ? (
          <>
            <div style={{ marginBottom:12 }}>
              <label style={S.label}>Password</label>
              <input
                style={S.input}
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                onKeyDown={e => e.key === 'Enter' && signIn()}
              />
            </div>
            {err && <div style={{ fontSize:13, color:C.red, marginBottom:12 }}>{err}</div>}
            <button
              style={{ ...S.btn('secondary'), width:'100%', padding:12, marginBottom:8, opacity: loading ? 0.6 : 1 }}
              onClick={signIn}
              disabled={loading}
            >
              {loading ? '⏳ Signing in…' : 'Sign In with Password'}
            </button>
            <div style={{ textAlign:'center', fontSize:12 }}>
              <span style={{ color:C.accent, cursor:'pointer', fontWeight:600 }} onClick={() => { setMode('login'); setErr('') }}>← Back</span>
            </div>
          </>
        ) : (
          <button style={{ ...S.btn('secondary'), width:'100%', padding:12 }} onClick={() => setMode('password')}>
            Sign In with Password
          </button>
        )}
      </div>
      <div style={{ ...S.card, marginTop:14, fontSize:13, color:C.muted, lineHeight:1.7, background:C.panel }}>
        💡 You'll stay signed in on this device — signing in is a once-per-device job, not a daily one.
      </div>
    </>
  )
}
