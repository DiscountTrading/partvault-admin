import { useState } from 'react'
import { sb } from '../lib/supabase'
import { C, S } from '../lib/constants'

export default function AuthScreen() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState('login')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [otpSent, setOtpSent] = useState(false)
  const [otp, setOtp] = useState('')

  const sendOtp = async () => {
    if (!email) { setErr('Enter your email'); return }
    setLoading(true); setErr('')
    const { error } = await sb.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false }
    })
    if (error) setErr(error.message)
    else setOtpSent(true)
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
    setLoading(false)
  }

  // OTP code entry screen
  if (otpSent) return (
    <div style={{ minHeight:'100vh', background:'linear-gradient(135deg,#f5f4f0,#edeae3)', display:'flex', alignItems:'center', justifyContent:'center', padding:24 }}>
      <div style={{ maxWidth:400, width:'100%' }}>
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
      </div>
    </div>
  )

  return (
    <div style={{ minHeight:'100vh', background:'linear-gradient(135deg,#f5f4f0,#edeae3)', display:'flex', alignItems:'center', justifyContent:'center', padding:24 }}>
      <div style={{ width:'100%', maxWidth:400 }}>
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
              autoFocus
            />
          </div>
          {err && !mode.includes('password') && <div style={{ fontSize:13, color:C.red, marginBottom:12 }}>{err}</div>}
          <button
            style={{ ...S.btn(), width:'100%', padding:14, fontSize:15, marginBottom:16, opacity: loading ? 0.6 : 1 }}
            onClick={sendOtp}
            disabled={loading}
          >
            {loading ? '⏳ Sending…' : '✉️ Send Login Code'}
          </button>
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
          💡 Enter your email above and we'll send a 6-digit login code.
        </div>
      </div>
    </div>
  )
}
