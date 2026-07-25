/**
 * FAKE fixture prose for the development and test flow. It is original filler text, never book
 * content, and it exists only so the whole upload-to-M4B flow can run with no GPU and no models.
 * Dialogue is quoted with typographic quotes and attributed by the following narration so
 * `FakeDirectorModel` can classify it deterministically.
 */
export interface FixtureChapter {
  readonly title: string
  readonly passages: readonly string[]
}

export const FIXTURE_CHAPTERS: readonly FixtureChapter[] = [
  {
    title: 'The Lamp on the Bridge',
    passages: [
      'The river carried the last of the evening light under the bridge, and the lamps came on one by one.',
      '“You are late again,” Alice said, without turning around.',
      'She had been counting barges since noon, and the cold had settled into her sleeves.',
      '“The gate keeper wanted a name,” Bruno answered, shaking the rain from his coat.',
    ],
  },
  {
    title: 'A Name Worth Keeping',
    passages: [
      'They walked the towpath until the lamps thinned out and the town became a rumour behind them.',
      '“Then give him mine,” Alice said, and the words sounded smaller than she wanted.',
      'Somewhere ahead a bell rang twice, paused, and rang again.',
      '“That is not how a name works,” said the voice from the dark, and neither of them answered it.',
    ],
  },
  {
    title: 'What the Courier Carried',
    passages: [
      'The satchel weighed almost nothing, which was the part that frightened her most.',
      '“Open it when the bell stops,” Bruno said, and he did not explain which bell.',
      'The bell did not stop that night, and the courier walked on with the lamp swinging beside her.',
    ],
  },
]
