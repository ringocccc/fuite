import { createReadStream } from 'node:fs'
import { diffFromStreams, DevToolsAPI } from 'heap-snapshot-toolkit'
import { sortBy } from '../../util.js'

// Make the simplifying assumption that certain classes, especially browser-internal
// ones, aren't really leaks
const browserInternalClasses = new Set([
  // Closures and regexes are a bit unique in that there is no other way to capture when these things leak,
  // other than using the internal "(...)" classes. Even "(array)" has a corresponding "Array" we can track.
  // As for numbers and strings, these just seem too small to be worth tracking on their own.
  // '(closure)',
  // '(regexp)',
  '(array)',
  '(compiled code)',
  '(concatenated string)',
  '(object shape)',
  '(number)',
  '(sliced string)',
  '(string)',
  '(system)',
  'InternalNode',
  'DOMRectReadOnly', // used by LayoutShift/LayoutShiftAttribution, gBCR returns DOMRect
  'LayoutShift',
  'LayoutShiftAttribution',
  'PerformanceEntry',
  'PerformanceEventTiming',
  'PerformanceLongAnimationFrameTiming',
  'PerformanceLongTaskTiming',
  'PerformanceNavigation',
  'PerformanceNavigationTiming',
  'PerformancePaintTiming',
  'PerformanceResourceTiming',
  'PerformanceTiming',
  'TaskAttributionTiming',
  'system / Context'
])

export async function analyzeHeapSnapshots (startSnapshotFilename, endSnapshotFilename, numIterations) {
  // Read in snapshots serially to avoid using too much memory at once
  const iterator = diffFromStreams(createReadStream(startSnapshotFilename, 'utf-8'), createReadStream(endSnapshotFilename, 'utf-8'))

  let startStatistics
  let endStatistics
  let startAggregates
  let endAggregates
  let diffByClassName
  for await (const item of iterator) {
    if (item.type === 'start') {
      const startSnapshot = item.result
      startStatistics = { ...startSnapshot.getStatistics() }
      startAggregates = startSnapshot.aggregatesWithFilter(new DevToolsAPI.HeapSnapshotModel.NodeFilter())
    } else if (item.type === 'end') {
      const endSnapshot = item.result
      endStatistics = { ...endSnapshot.getStatistics() }
      endAggregates = endSnapshot.aggregatesWithFilter(new DevToolsAPI.HeapSnapshotModel.NodeFilter())
    } else if (item.type === 'diff') {
      diffByClassName = item.result
    }
  }

  const suspiciousObjects = Object.entries(diffByClassName).filter(([name, diff]) => {
    // look for objects added <iteration> times and not 0 times
    return diff.countDelta % numIterations === 0 && diff.countDelta > 0
  })

  let leakingObjects = suspiciousObjects
    // filter browser internals
    .filter(([name]) => !browserInternalClasses.has(name))
    // Skip any objects that, for whatever reason, aren't in the aggregate collection.
    // We can't do anything with these
    .filter(([name]) => (name in startAggregates && name in endAggregates))

  leakingObjects = leakingObjects.map(([name, diff]) => {
    const startAggregatesForThisClass = startAggregates[name]
    const endAggregatesForThisClass = endAggregates[name]
    const retainedSizeDelta = endAggregatesForThisClass.maxRet - startAggregatesForThisClass.maxRet
    const retainedSizeDeltaPerIteration = Math.round(retainedSizeDelta / numIterations)
    const countDelta = diff.countDelta
    const countDeltaPerIteration = countDelta / numIterations
    return {
      // The "name" here is actually a combination of the class name and the code positions to handle objects
      // with the same name. E.g. `8,12,2,SomeBigObject` instead of `SomeBigObject`. For readability we just
      // want the short name, which can be found in the aggregate object
      name: startAggregatesForThisClass.name,
      diff: { ...diff },
      aggregates: {
        before: { ...startAggregatesForThisClass },
        after: { ...endAggregatesForThisClass }
      },
      retainedSizeDelta,
      retainedSizeDeltaPerIteration,
      countDelta,
      countDeltaPerIteration,
      numIterations
    }
  })
  leakingObjects = sortBy(leakingObjects, ['countDelta', 'name'])

  return { leakingObjects, startStatistics, endStatistics }
}
