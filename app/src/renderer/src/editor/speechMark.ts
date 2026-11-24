// The sentence being read aloud, highlighted in its editor and kept in view.

import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'

const setSpeech = StateEffect.define<{ from: number; to: number } | null>()
const mark = Decoration.mark({ class: 'cm-speech' })

export const speechExtension = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    let next = marks.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (!effect.is(setSpeech)) continue
      const range = effect.value
      next = range && range.to > range.from ? Decoration.set([mark.range(range.from, range.to)]) : Decoration.none
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})

/** Highlights [from, to) and scrolls it into view, or clears the highlight (null). */
export function markSpeech(view: EditorView, range: { from: number; to: number } | null) {
  const length = view.state.doc.length
  const clamped = range ? { from: Math.min(range.from, length), to: Math.min(range.to, length) } : null
  view.dispatch({
    effects: clamped
      ? [setSpeech.of(clamped), EditorView.scrollIntoView(clamped.from, { y: 'nearest', yMargin: 96 })]
      : [setSpeech.of(null)],
  })
}
