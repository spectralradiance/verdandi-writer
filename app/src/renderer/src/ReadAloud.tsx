import { Pause, Play, SkipBack, SkipForward, X } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'

import { type SpeechSegment, speechSegments } from '../../shared/speech'
import type { MarkdownEditorHandle } from './editor/MarkdownEditor'
import { readPref, writePref } from './prefs'
import { loadVoices, pickVoice, speaker, speechSupported } from './speaker'

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2]

interface ReadAloudProps {
  /** The document's section grid. */
  editor: () => MarkdownEditorHandle | null
  onClose: () => void
}

/** Every piece to say in the sections in view, and which to start at. */
function gather(editor: MarkdownEditorHandle | null, from: { id: number; offset: number } | null): { segments: SpeechSegment[]; index: number } {
  const source = editor?.speechRows?.()
  if (!source) return { segments: [], index: 0 }
  const segments = source.rows.flatMap((row) => speechSegments(row.id, row.text))
  const start = from ?? source.start
  if (!start) return { segments, index: 0 }
  const index = segments.findIndex((segment) => segment.row === start.id && segment.end > start.offset)
  const later = segments.findIndex((segment, at) => at > 0 && segments[at - 1].row === start.id && segment.row !== start.id)
  return { segments, index: index >= 0 ? index : Math.max(0, later) }
}

/**
 * Reads the document aloud, sentence by sentence, from the cursor (or the top of the
 * screen): the sentence being said is highlighted and kept in view. Floating controls
 * go back or on a sentence, pause, and set the speed and voice, kept on this computer.
 */
export function ReadAloud({ editor, onClose }: ReadAloudProps) {
  const state = useSyncExternalStore(speaker.subscribe, speaker.getSnapshot)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [voiceUri, setVoiceUri] = useState(() => readPref('speechVoice'))
  const [rate, setRate] = useState(() => Number(readPref('speechRate')) || 1)
  const [finished, setFinished] = useState(false)
  const voice = pickVoice(voices, voiceUri)

  useEffect(() => {
    void loadVoices().then(setVoices)
  }, [])

  useEffect(() => {
    speaker.configure({ voice, rate })
  }, [voice, rate])

  // Start when opened; stop, and clear the highlight, when closed.
  useEffect(() => {
    speaker.onSegment = (segment) => {
      editor()?.markSpeechIn?.(segment?.row ?? null, segment ? { from: segment.start, to: segment.end } : null)
      setFinished(segment === null)
    }
    const { segments, index } = gather(editor(), null)
    speaker.load(segments, index)
    speaker.play(index)
    return () => {
      speaker.onSegment = null
      speaker.stop()
      editor()?.markSpeechIn?.(null, null)
    }
  }, [editor])

  // Playing again reads the text as it is now: from the sentence it stopped at, or, once
  // it has finished, from the cursor or the top of the screen again.
  const resume = () => {
    const current = finished ? undefined : speaker.current()
    const { segments, index } = gather(editor(), current ? { id: current.row, offset: current.start } : null)
    speaker.load(segments, index)
    setFinished(false)
    speaker.play()
  }

  const chooseRate = (next: number) => {
    setRate(next)
    writePref('speechRate', String(next))
    speaker.configure({ rate: next }, true)
  }
  const chooseVoice = (uri: string) => {
    setVoiceUri(uri)
    writePref('speechVoice', uri)
    speaker.configure({ voice: voices.find((item) => item.voiceURI === uri) ?? null }, true)
  }

  const base = navigator.language.split('-')[0].toLowerCase()
  const choices = voices.filter((item) => item.lang.toLowerCase().startsWith(base))

  return (
    <div className="read-aloud" role="region" aria-label="Read aloud">
      {!speechSupported() ? <span className="lexical-hint">Reading aloud is not available here.</span> : (
        <>
          <button type="button" className="icon-button" onClick={() => speaker.skip(-1)} aria-label="Previous sentence" title="Previous sentence">
            <SkipBack size={14} aria-hidden="true" />
          </button>
          <button type="button" className="read-aloud-play" onClick={() => (state.playing ? speaker.stop() : resume())}
            aria-label={state.playing ? 'Pause' : 'Read aloud'} title={state.playing ? 'Pause' : finished ? 'Read again from the cursor' : 'Go on reading'}>
            {state.playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
          </button>
          <button type="button" className="icon-button" onClick={() => speaker.skip(1)} aria-label="Next sentence" title="Next sentence">
            <SkipForward size={14} aria-hidden="true" />
          </button>
          <span className="read-aloud-place" title="Sentence">
            {state.length ? `${Math.min(state.index + 1, state.length).toLocaleString()} / ${state.length.toLocaleString()}` : 'Nothing to read'}
          </span>
          <select value={rate} onChange={(event) => chooseRate(Number(event.target.value))} aria-label="Speed">
            {RATES.map((value) => <option key={value} value={value}>{value}×</option>)}
          </select>
          {choices.length > 1 && (
            <select className="read-aloud-voice" value={voice?.voiceURI ?? ''} onChange={(event) => chooseVoice(event.target.value)} aria-label="Voice">
              {choices.map((item) => <option key={item.voiceURI} value={item.voiceURI}>{item.name}</option>)}
            </select>
          )}
          {state.error && <span className="status-error">{state.error}</span>}
        </>
      )}
      <button type="button" className="icon-button" onClick={onClose} aria-label="Stop reading aloud" title="Stop reading aloud"><X size={14} aria-hidden="true" /></button>
    </div>
  )
}
