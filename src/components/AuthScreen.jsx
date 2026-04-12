import { useState } from 'react'
import { sb } from '../lib/supabase'
import { C, S } from '../lib/constants'

export default function AuthScreen() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState('login')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [magicSent, setMagicSent] = useState(false)

  const sendMagic = async () => {
    if (!email) { setErr('Enter your email'); return }
    setLoading(true); setErr('')
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin + window.location.pathname } })
    if (error) setErr(error.message)
    else setMagicSent(true)
    setLoading(false)
  }

  const signIn = async () => {
    if (!email || !password) { setErr('Enter email and password'); return }
    setLoading(true); setErr('')
    const { error } = await sb.auth.signInWithPassword({ email, password })
    if (error) setErr(error.message)
    setLoading(false)
  }

  if (magicSent) return (
    <div style={{ minHeight:'100vh', background:'linear-gradient(135deg,#f5f4f0,#edeae3)', display:'flex', alignItems:'center', justifyContent:'center', padding:24 }}>
      <div style={{ maxWidth:400, width:'100%', textAlign:'center' }}>
        <div style={{ fontSize:64, marginBottom:16 }}>📧</div>
        <div style={{ fontSize:24, fontWeight:800, color:C.text, marginBottom:12 }}>Check your email</div>
        <div style={{ fontSize:15, color:C.muted, marginBottom:24, lineHeight:1.7 }}>
          We sent a login link to <strong style={{color:C.text}}>{email}</strong>. Click it to sign in.
        </div>
        <button style={{ ...S.btn('secondary'), padding:'12px 24px' }} onClick={()=>setMagicSent(false)}>← Back</button>
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
            <input style={S.input} type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="your@email.com" autoFocus />
          </div>
          <button style={{ ...S.btn(), width:'100%', padding:14, fontSize:15, marginBottom:16 }} onClick={sendMagic} disabled={loading}>
            {loading ? '⏳ Sending…' : '✉️ Send Magic Login Link'}
          </button>
          <div style={{ textAlign:'center', fontSize:12, color:C.muted, marginBottom:16 }}>— or sign in with password —</div>
          {mode === 'password' ? (
            <>
              <div style={{ marginBottom:12 }}>
                <label style={S.label}>Password</label>
                <input style={S.input} type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••" onKeyDown={e=>e.key==='Enter'&&signIn()} />
              </div>
              {err && <div style={{ fontSize:13, color:C.red, marginBottom:12 }}>{err}</div>}
              <button style={{ ...S.btn('secondary'), width:'100%', padding:12, marginBottom:8 }} onClick={signIn} disabled={loading}>
                {loading ? '⏳ Signing in…' : 'Sign In with Password'}
              </button>
              <div style={{ textAlign:'center', fontSize:12 }}>
                <span style={{ color:C.accent, cursor:'pointer', fontWeight:600 }} onClick={()=>{setMode('login');setErr('')}}>← Back</span>
              </div>
            </>
          ) : (
            <button style={{ ...S.btn('secondary'), width:'100%', padding:12 }} onClick={()=>setMode('password')}>
              Sign In with Password
            </button>
          )}
        </div>
        <div style={{ ...S.card, marginTop:14, fontSize:13, color:C.muted, lineHeight:1.7, background:C.panel }}>
          💡 Magic link is the easiest way to sign in — same account as the mobile app.
        </div>
      </div>
    </div>
  )
}
