// Reading aloud: a thin layer over the Web Speech API, after Urdr Reader's
// (src/features/tts/speaker.ts). It speaks one piece at a time, so "pause" is
// stop-and-remember: restarting a sentence is better than losing it.
//
// There's one speech engine per app, so there's one Speaker: `speaker`, below.

import type { SpeechSegment } from '../../shared/speech'

export interface SpeakerState {
  playing: boolean
  index: number
  length: number
  error: string | null
}

export const speechSupported = () => typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window

export class Speaker {
  private segments: SpeechSegment[] = []
  private index = 0
  /** Bumped on every start and stop, so callbacks from cancelled utterances are ignored. */
  private run = 0
  private playing = false
  private error: string | null = null
  private voice: SpeechSynthesisVoice | null = null
  private rate = 1
  /** A piece started being spoken; null when speech stops or ends. */
  onSegment: ((segment: SpeechSegment | null) => void) | null = null

  private listeners = new Set<() => void>()
  private snapshot: SpeakerState = { playing: false, index: 0, length: 0, error: null }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }
  getSnapshot = () => this.snapshot
  private changed() {
    const { playing, index, error } = this
    const length = this.segments.length
    const previous = this.snapshot
    if (previous.playing === playing && previous.index === index && previous.error === error && previous.length === length) return
    this.snapshot = { playing, index, length, error }
    for (const listener of this.listeners) listener()
  }

  /** The piece being said, or about to be. */
  current(): SpeechSegment | undefined {
    return this.segments[this.index]
  }

  /** Voice and speed; `restart` applies them to the sentence being spoken. */
  configure(settings: { voice?: SpeechSynthesisVoice | null; rate?: number }, restart = false) {
    if (settings.voice !== undefined) this.voice = settings.voice
    if (settings.rate !== undefined) this.rate = settings.rate
    if (restart && this.playing) this.play(this.index)
  }

  /** New pieces to say (stopping first), starting from `index`. */
  load(segments: SpeechSegment[], index = 0) {
    this.stop()
    this.segments = segments
    this.index = Math.min(Math.max(0, index), Math.max(0, segments.length - 1))
    this.changed()
  }

  play(from = this.index) {
    if (!speechSupported() || this.segments.length === 0) return
    this.index = Math.min(Math.max(0, from), this.segments.length - 1)
    this.playing = true
    this.error = null
    const run = ++this.run
    speechSynthesis.cancel()
    this.speak(run)
  }

  stop() {
    this.run += 1
    this.playing = false
    if (speechSupported()) speechSynthesis.cancel()
    this.changed()
  }

  /** Moves by pieces, playing or paused. */
  skip(delta: number) {
    const next = Math.min(Math.max(0, this.index + delta), this.segments.length - 1)
    if (this.playing) this.play(next)
    else {
      this.index = next
      this.changed()
      const segment = this.segments[next]
      if (segment) this.onSegment?.(segment)
    }
  }

  private speak(run: number) {
    const segment = this.segments[this.index]
    if (!segment) return
    const utterance = new SpeechSynthesisUtterance(segment.text)
    if (this.voice) {
      utterance.voice = this.voice
      utterance.lang = this.voice.lang
    }
    utterance.rate = this.rate
    utterance.addEventListener('end', () => {
      if (run !== this.run) return
      if (this.index + 1 < this.segments.length) {
        this.index += 1
        this.speak(run)
      } else {
        this.playing = false
        this.changed()
        this.onSegment?.(null)
      }
    })
    utterance.addEventListener('error', (event) => {
      if (run !== this.run || event.error === 'interrupted' || event.error === 'canceled') return
      this.playing = false
      this.error = `Speech stopped (${event.error})`
      this.changed()
    })
    this.changed()
    this.onSegment?.(segment)
    speechSynthesis.speak(utterance)
  }
}

export const speaker = new Speaker()

/** The installed voices, waiting for the list when it loads late. */
export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  if (!speechSupported()) return Promise.resolve([])
  const now = speechSynthesis.getVoices()
  if (now.length) return Promise.resolve(now)
  return new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices())
    speechSynthesis.addEventListener('voiceschanged', done, { once: true })
    window.setTimeout(done, 1500)
  })
}

/** The voice to use: the one chosen, else the default for the language, else a local one. */
export function pickVoice(voices: SpeechSynthesisVoice[], preferred: string | null): SpeechSynthesisVoice | null {
  const chosen = preferred ? voices.find((voice) => voice.voiceURI === preferred) : undefined
  if (chosen) return chosen
  const base = navigator.language.split('-')[0].toLowerCase()
  const matching = voices.filter((voice) => voice.lang.toLowerCase().startsWith(base))
  return matching.find((voice) => voice.default) ?? matching.find((voice) => voice.localService) ?? matching[0] ?? voices.find((voice) => voice.default) ?? null
}
