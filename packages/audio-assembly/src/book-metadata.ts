import type { AssemblyPlan, PlannedChapter } from './assembly-plan.js'

const AUDIOBOOK_GENRE = 'Audiobook'
/** iTunes `stik` value for an audiobook, so players shelve the export correctly. */
const AUDIOBOOK_MEDIA_TYPE = '2'

export type MetadataTag = readonly [key: string, value: string]

/**
 * Maps the book's available metadata onto container tags. The domain `Book` exposes title, author,
 * and cover, so those are what can be written; empty values are dropped downstream rather than
 * written as blank tags.
 */
export const buildBookTags = (plan: AssemblyPlan): readonly MetadataTag[] => {
  const tags: MetadataTag[] = [
    ['title', plan.title],
    ['album', plan.title],
    ['genre', AUDIOBOOK_GENRE],
    ['media_type', AUDIOBOOK_MEDIA_TYPE],
  ]
  if (plan.author !== null) {
    tags.push(['artist', plan.author], ['album_artist', plan.author], ['composer', plan.author])
  }
  return Object.freeze(tags)
}

/** Chapter masters carry their own title plus the book tags that make them playable standalone. */
export const buildChapterTags = (
  plan: AssemblyPlan,
  chapter: PlannedChapter,
): readonly MetadataTag[] => {
  const tags: MetadataTag[] = [
    ['title', chapter.title],
    ['album', plan.title],
    ['genre', AUDIOBOOK_GENRE],
    ['track', `${chapter.position}/${plan.chapters.length}`],
  ]
  if (plan.author !== null) {
    tags.push(['artist', plan.author], ['album_artist', plan.author])
  }
  return Object.freeze(tags)
}
