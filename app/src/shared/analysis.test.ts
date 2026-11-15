import { describe, expect, it } from 'vitest'

import { analyzeStyle } from './analysis'

describe('analyzeStyle', () => {
  it('measures vocabulary', () => {
    const plain = analyzeStyle('The cat sat. The cat sat. The cat sat. The cat sat.')
    const varied = analyzeStyle('A heron stood motionless while silver minnows scattered beneath reeds.')
    expect(plain.distinctWords).toBe(3)
    expect(plain.variety).toBe(25)
    expect(varied.variety).toBe(100)
    expect(varied.wordLength).toBeGreaterThan(plain.wordLength)
    expect(varied.density).toBeGreaterThan(plain.density)
    expect(analyzeStyle('Beautiful, extraordinary, unbelievable.').longWords).toBe(100)
  })

  it('keeps variety steady as a text grows, using runs of 50 words', () => {
    const paragraph = 'Rain came over the hills and the river rose, carrying branches past the mill where the old keeper watched and counted them one by one until dark. '
    const once = analyzeStyle(paragraph.repeat(2)).variety
    const often = analyzeStyle(paragraph.repeat(12)).variety
    expect(Math.abs(once - often)).toBeLessThan(5)
  })

  it('estimates passive voice, adverbs, fillers, questions and dialogue', () => {
    const text = 'The letter was taken. She ran quickly home. It was really very late. Who knew? "Stay," he said.'
    const style = analyzeStyle(text)
    expect(style.passive).toBe(20)
    expect(style.adverbs).toBeGreaterThan(0)
    expect(style.fillers).toBeGreaterThan(0)
    expect(style.questions).toBe(20)
    expect(style.dialogue).toBeGreaterThan(0)
    expect(analyzeStyle('She was tired and the family was early.').passive).toBe(0)
    expect(analyzeStyle('Only the lonely fly early.').adverbs).toBe(0)
  })

  it('reads nothing as zeros', () => {
    expect(analyzeStyle('')).toMatchObject({ words: 0, variety: 0, passive: 0, dialogue: 0 })
  })
})
