import './style.css'
import * as faceapi from '@vladmandic/face-api'
import confetti from 'canvas-confetti'

type Emotion = 'neutral' | 'happy' | 'sad' | 'angry' | 'fearful' | 'disgusted' | 'surprised'
type Scores = Record<Emotion, number>
type Round = 'target' | 'mix' | 'mirror'
type ModeSetting = 'auto' | Round

const EMOTIONS: Emotion[] = ['happy', 'surprised', 'sad', 'angry', 'neutral', 'fearful', 'disgusted']
// fearful and disgusted are hard for the model to pick up, and neutral isn't fun as a goal,
// so rounds only ask for the expressive, reliable ones
const ROUND_TARGETS: Emotion[] = ['happy', 'surprised', 'sad', 'angry']
// auto mode cycles through these; mix and mirror need at least two people
const ROUND_ORDER: Round[] = ['target', 'mix', 'mirror']

const INFO: Record<Emotion, { emoji: string; ja: string; en: string; promptJa: string; promptEn: string }> = {
  happy: { emoji: '😄', ja: '笑顔', en: 'Happy', promptJa: 'みんなで笑って！', promptEn: 'Big smiles, everyone!' },
  surprised: { emoji: '😮', ja: '驚き', en: 'Surprised', promptJa: 'びっくりした顔！', promptEn: 'Look surprised! Eyebrows up, mouth open.' },
  sad: { emoji: '😢', ja: '悲しみ', en: 'Sad', promptJa: 'いちばん悲しい顔をして', promptEn: 'Show us your saddest face.' },
  angry: { emoji: '😠', ja: '怒り', en: 'Angry', promptJa: '怒った顔を見せて！', promptEn: 'Grrr! Frown like you mean it.' },
  neutral: { emoji: '😐', ja: '真顔', en: 'Neutral', promptJa: '真顔で…じっと', promptEn: 'Poker face. Totally still.' },
  fearful: { emoji: '😨', ja: '恐れ', en: 'Scared', promptJa: '怖がって！', promptEn: 'Look scared!' },
  disgusted: { emoji: '🤢', ja: '嫌悪', en: 'Disgusted', promptJa: 'うえっ！嫌な顔', promptEn: 'Ew! Wrinkle your nose.' },
}

// one colour per player, all from the strawberry palette
const PLAYER_COLORS = ['#e63950', '#3a9d5d', '#f2994a', '#9b51e0', '#2d9cdb', '#d4a017']
const SMOOTHING = 0.35 // weight of the newest frame in the moving average
const CELEBRATE_MS = 6500 // how long the success photo stays up before the next round

// ---------- settings (persisted, edited in the hidden S dialog) ----------
const DEFAULTS = { mode: 'auto' as ModeSetting, holdSeconds: 3, threshold: 0.6, roundTimeout: 30, ignoreNeutral: true }
type Settings = typeof DEFAULTS
const settings: Settings = { ...DEFAULTS, ...load<Settings>('ichigo-settings') }

function load<T>(key: string): Partial<T> {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}')
  } catch {
    return {}
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable, keep going */
  }
}

// ---------- DOM ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const video = $<HTMLVideoElement>('video')
const canvas = $<HTMLCanvasElement>('overlay')
const ctx = canvas.getContext('2d')!
const statusEl = $('status')
const celebrateEl = $('celebrate')
const promptJa = $('promptJa')
const promptEn = $('promptEn')
const holdJa = $('holdJa')
const holdEn = $('holdEn')
const jam = $('jam')
const peopleEl = $('people')
const scoreEl = $('score')
const roundBadge = $('roundBadge')
const dialog = $<HTMLDialogElement>('settings')
const photoEl = $('photo')
const snapshot = $<HTMLCanvasElement>('snapshot')
const photoCaption = $('photoCaption')
const photoJa = $('photoJa')
const photoEn = $('photoEn')
const photoStamp = $('photoStamp')
const photoTimer = $('photoTimer')

// ---------- state ----------
let round: Round = 'target'
let assignments: Emotion[] = [] // mix round: one emotion per player, left to right
let target: Emotion = 'happy'
let held = 0
let score = Number(load<{ score: number }>('ichigo-score').score ?? 0)
let roundStarted = performance.now()
let celebrateUntil = 0
let lastTime = performance.now()
scoreEl.textContent = String(score)

interface Face {
  box: { x: number; y: number; width: number; height: number }
  scores: Scores
}
let faces: Face[] = []

// ---------- settings dialog ----------
function bindRange(id: keyof Settings, toUi = (v: number) => v, fromUi = (v: number) => v) {
  const input = $<HTMLInputElement>(id)
  const label = $(`${id}Val`)
  input.value = String(toUi(settings[id] as number))
  label.textContent = input.value
  input.addEventListener('input', () => {
    ;(settings[id] as number) = fromUi(Number(input.value))
    label.textContent = input.value
    save('ichigo-settings', settings)
  })
}
bindRange('holdSeconds')
bindRange('roundTimeout')
bindRange('threshold', (v) => Math.round(v * 100), (v) => v / 100)

const modeSelect = $<HTMLSelectElement>('modeSetting')
modeSelect.value = settings.mode
modeSelect.addEventListener('change', () => {
  settings.mode = modeSelect.value as ModeSetting
  save('ichigo-settings', settings)
  nextRound()
})
const ignoreNeutral = $<HTMLInputElement>('ignoreNeutral')
ignoreNeutral.checked = settings.ignoreNeutral
ignoreNeutral.addEventListener('change', () => {
  settings.ignoreNeutral = ignoreNeutral.checked
  save('ichigo-settings', settings)
})
$('resetScore').addEventListener('click', () => setScore(0))
$('gear').addEventListener('click', () => dialog.showModal())

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
  const key = e.key.toLowerCase()
  if (key === 's') dialog.open ? dialog.close() : dialog.showModal()
  if (key === 'f') toggleFullscreen()
  if (key === 'n') nextRound()
  if (key === 'w' && import.meta.env.DEV) win() // dev only: force a win to check the success photo
})
document.addEventListener('dblclick', toggleFullscreen)

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen()
  else document.documentElement.requestFullscreen().catch(() => {})
}

function setScore(n: number) {
  score = n
  scoreEl.textContent = String(score)
  save('ichigo-score', { score })
}

// ---------- rounds ----------
function nextRound() {
  if (settings.mode === 'auto') {
    const next = ROUND_ORDER[(ROUND_ORDER.indexOf(round) + 1) % ROUND_ORDER.length]
    round = faces.length >= 2 ? next : 'target'
  } else round = settings.mode
  if (round === 'target') {
    const options = ROUND_TARGETS.filter((e) => e !== target)
    target = options[Math.floor(Math.random() * options.length)]
  }
  if (round === 'mix') assignments = shuffle(ROUND_TARGETS)
  held = 0
  roundStarted = performance.now()
}

// ---------- helpers ----------
function shuffle<T>(items: T[]): T[] {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const dominant = (s: Scores): Emotion =>
  (Object.keys(s) as Emotion[]).reduce((a, b) => (s[a] >= s[b] ? a : b))

// 1 = identical expression distributions, 0 = completely different
function similarity(a: Scores, b: Scores): number {
  let diff = 0
  for (const e of EMOTIONS) diff += Math.abs(a[e] - b[e])
  return 1 - diff / 2
}

function center(f: Face) {
  return { x: f.box.x + f.box.width / 2, y: f.box.y + f.box.height / 2 }
}

// Match new detections to previous faces by distance so smoothing follows the same person
function track(detected: Face[]): Face[] {
  const prev = [...faces]
  const result = detected.map((d) => {
    const c = center(d)
    let best = -1
    let bestDist = Infinity
    prev.forEach((p, i) => {
      const pc = center(p)
      const dist = Math.hypot(pc.x - c.x, pc.y - c.y)
      if (dist < bestDist && dist < d.box.width) {
        best = i
        bestDist = dist
      }
    })
    if (best < 0) return d
    const old = prev.splice(best, 1)[0]
    const scores = {} as Scores
    for (const e of EMOTIONS) scores[e] = old.scores[e] * (1 - SMOOTHING) + d.scores[e] * SMOOTHING
    return { box: d.box, scores }
  })
  // left-to-right on screen (video is mirrored, so larger x in video = further left)
  return result.sort((a, b) => b.box.x - a.box.x)
}

// ---------- game logic ----------
function update(dt: number) {
  const now = performance.now()
  let success = false
  let progress: number[] = []
  let ja = ''
  let en = ''

  // rounds adapt to who is in front of the camera
  if (settings.mode === 'auto' && round !== 'target' && faces.length < 2) nextRound()
  if (settings.mode !== 'auto' && round !== settings.mode) nextRound()
  if (faces.length > 0 && now - roundStarted > settings.roundTimeout * 1000 && held === 0) nextRound()

  if (faces.length === 0) {
    ja = 'カメラの前に来てね！'
    en = 'Step in front of the camera!'
    roundStarted = now
  } else if (round === 'target') {
    progress = faces.map((f) => Math.min(1, f.scores[target] / settings.threshold))
    success = faces.every((f) => f.scores[target] >= settings.threshold)
    ja = `${INFO[target].emoji} ${INFO[target].promptJa}`
    en = INFO[target].promptEn
  } else if (faces.length < 2) {
    ja = '👯 もう一人呼んでね！'
    en = 'Grab a friend for this round!'
  } else if (round === 'mix') {
    // everyone gets a different emotion; players beyond the list wait their turn
    const players = faces.slice(0, assignments.length)
    progress = players.map((f, i) => Math.min(1, f.scores[assignments[i]] / settings.threshold))
    success = players.every((f, i) => f.scores[assignments[i]] >= settings.threshold)
    ja = '🎭 みんなバラバラの表情で！'
    en = players.map((_, i) => `P${i + 1} ${INFO[assignments[i]].emoji} ${INFO[assignments[i]].en.toLowerCase()}`).join(' · ')
  } else {
    const [a, b] = faces
    const sim = similarity(a.scores, b.scores)
    const da = dominant(a.scores)
    const db = dominant(b.scores)
    const bothNeutral = settings.ignoreNeutral && da === 'neutral' && db === 'neutral'
    const p = Math.min(1, sim / settings.threshold)
    progress = [p, p]
    success = sim >= settings.threshold && da === db && !bothNeutral
    if (success || bothNeutral) {
      ja = '🪞 お互いの表情をまねしよう！'
      en = 'Make a face, and your partner copies it!'
    } else {
      // the stronger, non-neutral expression leads
      const weight = (e: Emotion, s: Scores) => s[e] * (e === 'neutral' ? 0.5 : 1)
      const aLeads = weight(da, a.scores) >= weight(db, b.scores)
      const lead = aLeads ? da : db
      const [leader, follower] = aLeads ? [1, 2] : [2, 1]
      ja = `🪞 P${follower}、P${leader}の${INFO[lead].emoji}${INFO[lead].ja}をまねして！`
      en = `P${follower}, copy P${leader}'s ${INFO[lead].en.toLowerCase()} face!`
    }
  }

  if (now < celebrateUntil) {
    success = false
    held = 0
  } else if (success) {
    held += dt
    if (held >= settings.holdSeconds) win()
  } else {
    held = Math.max(0, held - dt * 2) // decay rather than reset so a flicker isn't fatal
  }

  promptJa.textContent = ja
  promptEn.textContent = en
  document.body.classList.toggle('matching', success)
  const pct = Math.min(1, held / settings.holdSeconds)
  jam.style.height = `${pct * 100}%`
  if (success) {
    holdJa.textContent = `そのまま！ あと${Math.max(0, settings.holdSeconds - held).toFixed(1)}秒`
    holdEn.textContent = 'Hold it! The jar is filling up'
  } else {
    holdJa.textContent = 'そろったらジャムがたまるよ'
    holdEn.textContent = 'Match to fill the jam jar'
  }
  roundBadge.innerHTML = {
    target: `<span>🎯 お題 · Target</span><b>${INFO[target].emoji} ${INFO[target].ja} · ${INFO[target].en}</b>`,
    mix: `<span>🎭 バラバラ · Mix</span><b>みんなちがう顔 · Mixed feelings</b>`,
    mirror: `<span>🪞 ミラー · Mirror</span><b>まねっこ · Mirror match</b>`,
  }[round]
  renderPeople(progress)
  draw(progress)
}

function win() {
  if (performance.now() < celebrateUntil) return
  setScore(score + 1)
  held = 0
  celebrateUntil = performance.now() + CELEBRATE_MS
  const lines = [
    ['やった！', 'Sweet!'],
    ['ぴったり！', 'Perfect match!'],
    ['いちご一会！', 'A moment to remember!'],
    ['最高！', 'Jam-tastic!'],
  ]
  const [ja, en] = lines[Math.floor(Math.random() * lines.length)]
  showPhoto(ja, en)

  const strawberry = confetti.shapeFromText({ text: '🍓', scalar: 3 })
  const colors = ['#e63950', '#ff8fa3', '#ffffff', '#3a9d5d', '#ffd36b']
  confetti({ particleCount: 140, spread: 100, origin: { y: 0.6 }, colors })
  confetti({ particleCount: 40, spread: 120, origin: { y: 0.5 }, shapes: [strawberry], scalar: 3 })
  setTimeout(() => confetti({ particleCount: 80, angle: 60, spread: 60, origin: { x: 0 }, colors }), 250)
  setTimeout(() => confetti({ particleCount: 80, angle: 120, spread: 60, origin: { x: 1 }, colors }), 450)
  setTimeout(() => {
    photoEl.classList.remove('show')
    nextRound()
  }, CELEBRATE_MS)
}

// Success photo: the raw camera frame (no boxes or labels), mirrored like the live view,
// framed with what everyone was going for
function showPhoto(ja: string, en: string) {
  snapshot.width = video.videoWidth
  snapshot.height = video.videoHeight
  const g = snapshot.getContext('2d')!
  g.save()
  g.translate(snapshot.width, 0)
  g.scale(-1, 1)
  g.drawImage(video, 0, 0, snapshot.width, snapshot.height)
  g.restore()

  const chip = (e: Emotion, player?: number) =>
    `<span class="chip"${player === undefined ? '' : ` style="--c:${PLAYER_COLORS[player % PLAYER_COLORS.length]}"`}>` +
    `${player === undefined ? '' : `<b>P${player + 1}</b>`}<i>${INFO[e].emoji}</i>` +
    `<span><span class="cj">${INFO[e].ja}</span><span class="ce">${INFO[e].en}</span></span></span>`
  if (round === 'mix') {
    const players = faces.slice(0, assignments.length)
    photoCaption.innerHTML =
      `<div class="kind">🎭 バラバラ · Mixed feelings</div>` +
      `<div class="chips">${players.map((_, i) => chip(assignments[i], i)).join('')}</div>`
  } else if (round === 'mirror') {
    photoCaption.innerHTML = `<div class="kind">🪞 ミラー · Mirror match</div><div class="chips">${chip(dominant(faces[0].scores))}</div>`
  } else {
    photoCaption.innerHTML = `<div class="kind">🎯 お題 · Target</div><div class="chips">${chip(target)}</div>`
  }
  photoJa.textContent = ja
  photoEn.textContent = en
  const time = new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
  photoStamp.textContent = `🫙 #${score} · ${time}`
  photoTimer.style.animationDuration = `${CELEBRATE_MS}ms`
  // restart the CSS animations for this win
  photoEl.classList.remove('show')
  celebrateEl.classList.remove('flash')
  void photoEl.offsetWidth
  photoEl.classList.add('show')
  celebrateEl.classList.add('flash') // camera flash on the live view
}

// ---------- rendering ----------
function renderPeople(progress: number[]) {
  peopleEl.innerHTML = faces
    .slice(0, 6)
    .map((f, i) => {
      const dom = dominant(f.scores)
      const p = progress[i] ?? 0
      const goal = round === 'mix' && assignments[i] ? `<div class="goal">${INFO[assignments[i]].emoji}<small>${INFO[assignments[i]].ja}</small><small class="en">${INFO[assignments[i]].en}</small></div>` : ''
      return `<div class="person" style="--c:${PLAYER_COLORS[i % PLAYER_COLORS.length]}">
        <div class="tag">P${i + 1}</div>
        <div class="face">${INFO[dom].emoji}</div>
        <div class="info">
          <div class="emo-name">${INFO[dom].ja} <small>${INFO[dom].en}</small></div>
          ${progress[i] === undefined ? '<div class="waiting">次の番を待ってね · Up next</div>' : `<div class="bar"><div class="fill ${p >= 1 ? 'full' : ''}" style="width:${p * 100}%"></div></div>`}
        </div>
        ${goal}
      </div>`
    })
    .join('')
}

function roundRect(x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, r)
}

function draw(progress: number[]) {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  faces.forEach((f, i) => {
    const { y, width: w, height: h } = f.box
    const x = canvas.width - f.box.x - w // mirror to match the flipped video
    const dom = dominant(f.scores)
    const color = PLAYER_COLORS[i % PLAYER_COLORS.length]
    const p = progress[i] ?? 0

    ctx.lineWidth = Math.max(4, w / 40)
    ctx.strokeStyle = p >= 1 ? '#3a9d5d' : color
    roundRect(x, y, w, h, w / 6)
    ctx.stroke()

    const fs = Math.max(18, w / 6.5)
    ctx.font = `800 ${fs}px "M PLUS Rounded 1c", system-ui, sans-serif`
    // in the mix round the label shows each player's own goal instead of their current face
    const goal = round === 'mix' && faces.length >= 2 ? assignments[i] : undefined
    const shown = goal ?? dom
    const label = `P${i + 1} ${goal ? '→ ' : ''}${INFO[shown].emoji} ${INFO[shown].ja} · ${INFO[shown].en}`
    const tw = ctx.measureText(label).width
    ctx.fillStyle = color
    roundRect(x, y - fs - 16, tw + 24, fs + 12, (fs + 12) / 2)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.fillText(label, x + 12, y - 14)

    if (progress[i] !== undefined) {
      const bh = Math.max(12, h / 14)
      ctx.fillStyle = 'rgba(255,255,255,0.8)'
      roundRect(x, y + h + 10, w, bh, bh / 2)
      ctx.fill()
      ctx.fillStyle = p >= 1 ? '#3a9d5d' : '#e63950'
      if (p > 0.02) {
        roundRect(x, y + h + 10, w * p, bh, bh / 2)
        ctx.fill()
      }
    }
  })

  if (round === 'mirror' && faces.length >= 2) {
    const [a, b] = faces.map(center)
    ctx.setLineDash([14, 10])
    ctx.lineWidth = 5
    ctx.strokeStyle = progress[0] >= 1 ? '#3a9d5d' : 'rgba(255,255,255,0.8)'
    ctx.beginPath()
    ctx.moveTo(canvas.width - a.x, a.y)
    ctx.lineTo(canvas.width - b.x, b.y)
    ctx.stroke()
    ctx.setLineDash([])
  }
}

// ---------- main loop ----------
const detectorOptions = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 })

async function loop() {
  if (video.readyState >= 2) {
    const results = await faceapi.detectAllFaces(video, detectorOptions).withFaceExpressions()
    faces = track(
      results.map((r) => ({
        box: r.detection.box,
        scores: { ...(r.expressions as unknown as Scores) },
      })),
    )
  }
  const now = performance.now()
  update((now - lastTime) / 1000)
  lastTime = now
  requestAnimationFrame(loop)
}

async function start() {
  try {
    // the bundled tfjs typings omit these, but they exist at runtime
    const tf = faceapi.tf as unknown as { setBackend(b: string): Promise<boolean>; ready(): Promise<void> }
    await tf.setBackend('webgl')
    await tf.ready()
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(`${import.meta.env.BASE_URL}models`),
      faceapi.nets.faceExpressionNet.loadFromUri(`${import.meta.env.BASE_URL}models`),
    ])
    statusEl.innerHTML = '📷 カメラを起動中… <small>Starting camera…</small>'
    const testImage = new URLSearchParams(location.search).get('testImage')
    const stream = testImage
      ? await imageStream(testImage)
      : await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
          audio: false,
        })
    video.srcObject = stream
    await new Promise((r) => (video.onloadedmetadata = r))
    await video.play()
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    statusEl.remove()
    target = ROUND_TARGETS[Math.floor(Math.random() * ROUND_TARGETS.length)]
    lastTime = roundStarted = performance.now()
    loop()
  } catch (err) {
    console.error(err)
    statusEl.innerHTML = `⚠️ カメラを許可して再読み込みしてください <small>Allow camera access and reload (${err instanceof Error ? err.message : err})</small>`
  }
}

// Testing aid: ?testImage=<url> feeds a still image in place of the webcam
async function imageStream(url: string): Promise<MediaStream> {
  const img = new Image()
  img.crossOrigin = 'anonymous'
  img.src = url
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  const g = c.getContext('2d')!
  // a timer rather than requestAnimationFrame so the stream keeps flowing in a background tab
  g.drawImage(img, 0, 0)
  setInterval(() => g.drawImage(img, 0, 0), 1000 / 30)
  return c.captureStream(30)
}

start()
