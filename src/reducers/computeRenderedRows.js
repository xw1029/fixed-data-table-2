/**
 * Copyright Schrodinger, LLC
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule computeRenderedRows
 */

'use strict';

import updateRowHeight from 'updateRowHeight';
import roughHeightsSelector from 'roughHeights';
import scrollbarsVisibleSelector from 'scrollbarsVisible';
import tableHeightsSelector from 'tableHeights';

/**
 * Returns data about the rows to render
 * rows is a map of rowIndexes to render to their heights
 * firstRowIndex & firstRowOffset are calculated based on the lastIndex if
 * specified in scrollAnchor.
 * Otherwise, they are unchanged from the firstIndex & firstOffset scrollAnchor values.
 *
 * @param {!Object} state
 * @param {{
 *   firstIndex: number,
 *   firstOffset: number,
 *   lastIndex: number,
 * }} scrollAnchor
 * @return {!Object} The updated state object
 */
export default function computeRenderedRows(state, scrollAnchor) {
  const newState = Object.assign({}, state);
  let rowRange = calculateRenderedRowRange(newState, scrollAnchor);

  const { rowSettings, scrollContentHeight } = newState;
  const { rowsCount } = rowSettings;
  const { bodyHeight } = tableHeightsSelector(newState);
  const maxScrollY = scrollContentHeight - bodyHeight;

  // NOTE (jordan) This handles #115 where resizing the viewport may
  // leave only a subset of rows shown, but no scrollbar to scroll up to the first rows.
  if (maxScrollY === 0) {
    if (rowRange.firstViewportIdx > 0) {
      rowRange = calculateRenderedRowRange(newState, {
        firstOffset: 0,
        lastIndex: rowsCount - 1,
      });
    }

    newState.firstRowOffset = 0;
  }

  computeRenderedRowOffsets(newState, rowRange);
  if (rowsCount === 0) {
    scrollY = 0;
  } else {
    scrollY = newState.rowHeights[rowRange.firstViewportIdx] - newState.firstRowOffset;
  }
  scrollY = Math.min(scrollY, maxScrollY);

  return Object.assign(newState, {
    maxScrollY,
    scrollY,
  });
}

/**
 * Determine the range of rows to render (buffer and viewport)
 * The leading and trailing buffer is based on a fixed count,
 * while the viewport rows are based on their height and the viewport height
 * We use the scrollAnchor to determine what either the first or last row
 * will be, as well as the offset.
 *
 * NOTE (jordan) This alters state so it shouldn't be called
 * without state having been cloned first.
 *
 * @param {!Object} state
 * @param {{
 *   firstIndex: number,
 *   firstOffset: number,
 *   lastIndex: number,
 * }} scrollAnchor
 * @return {{
 *   endBufferIdx: number,
 *   endViewportIdx: number,
 *   firstBufferIdx: number,
 *   firstViewportIdx: number,
 * }}
 * @private
 */
function calculateRenderedRowRange(state, scrollAnchor) {
  const { bufferRowCount, maxAvailableHeight } = roughHeightsSelector(state);
  const rowsCount = state.rowSettings.rowsCount;

  if (rowsCount === 0) {
    return {
      endBufferIdx: 0,
      endViewportIdx: 0,
      firstBufferIdx: 0,
      firstViewportIdx: 0,
    };
  }


  // If our first or last index is greater than our rowsCount,
  // treat it as if the last row is at the bottom of the viewport
  let { firstIndex, firstOffset, lastIndex } = scrollAnchor;
  if (firstIndex >= rowsCount || lastIndex >= rowsCount) {
    lastIndex = rowsCount - 1;
  }

  // Walk the viewport until filled with rows
  // If lastIndex is set, walk backward so that row is the last in the viewport
  let step = 1;
  let startIdx = firstIndex;
  let totalHeight = firstOffset;
  if (lastIndex !== undefined) {
    step = -1;
    startIdx = lastIndex;
    totalHeight = 0;
  }

  // Loop to walk the viewport until we've touched enough rows to fill its height
  let rowIdx = startIdx;
  let endIdx = rowIdx;
  while (rowIdx < rowsCount && rowIdx >= 0 &&
      totalHeight < maxAvailableHeight) {
    totalHeight += updateRowHeight(state, rowIdx);
    endIdx = rowIdx;
    rowIdx += step;
  }

  // Loop to walk the leading buffer
  let firstViewportIdx = Math.min(startIdx, endIdx);
  const firstBufferIdx = Math.max(firstViewportIdx - bufferRowCount, 0);
  for (rowIdx = firstBufferIdx; rowIdx < firstViewportIdx; rowIdx++) {
    updateRowHeight(state, rowIdx);
  }

  // Loop to walk the trailing buffer
  const endViewportIdx = Math.max(startIdx, endIdx) + 1;
  const endBufferIdx = Math.min(endViewportIdx + bufferRowCount, rowsCount);
  for (rowIdx = endViewportIdx; rowIdx < endBufferIdx; rowIdx++) {
    updateRowHeight(state, rowIdx);
  }

  const { availableHeight } = scrollbarsVisibleSelector(state);
  if (lastIndex !== undefined) {
    // Calculate offset needed to position last row at bottom of viewport
    // This should be negative and represent how far the first row needs to be offscreen
    firstOffset = Math.min(availableHeight - totalHeight, 0);

    // Handle a case where the offset puts the first row fully offscreen
    // This can happen if availableHeight & maxAvailableHeight are different
    const { storedHeights } = state;
    if (-1 * firstOffset >= storedHeights[firstViewportIdx]) {
      firstViewportIdx += 1;
      firstOffset += storedHeights[firstViewportIdx];
    }
  }

  state.firstRowIndex = firstViewportIdx;
  state.firstRowOffset = firstOffset;
  return {
    endBufferIdx,
    endViewportIdx,
    firstBufferIdx,
    firstViewportIdx,
  };
}

/**
 * Walk the rows to render and compute the height offsets and
 * positions in the row buffer.
 *
 * NOTE (jordan) This alters state so it shouldn't be called
 * without state having been cloned first.
 *
 * @param {!Object} state
 * @param {{
 *   endBufferIdx: number,
 *   endViewportIdx: number,
 *   firstBufferIdx: number,
 *   firstViewportIdx: number,
 * }} rowRange
 * @private
 */
function computeRenderedRowOffsets(state, rowRange) {
  const { bufferSet, rowOffsets, storedHeights } = state;
  const {
    endBufferIdx,
    endViewportIdx,
    firstBufferIdx,
    firstViewportIdx,
  } = rowRange;

  const renderedRowsCount = endBufferIdx - firstBufferIdx;
  if (renderedRowsCount === 0) {
    state.rowHeights = {};
    state.rows = [];
    return;
  }

  const bufferMapping = []; // state.rows
  const rowOffsetsCache = {}; // state.rowHeights
  let runningOffset = rowOffsets.sumUntil(firstBufferIdx);
  for (let rowIdx = firstBufferIdx; rowIdx < endBufferIdx; rowIdx++) {

    // Update the offset for rendering the row
    rowOffsetsCache[rowIdx] = runningOffset;
    runningOffset += storedHeights[rowIdx];

    // Check if row already has a position in the buffer
    let rowPosition = bufferSet.getValuePosition(rowIdx);

    // Request a position in the buffer through eviction of another row
    if (rowPosition === null && bufferSet.getSize() >= renderedRowsCount) {
      rowPosition = bufferSet.replaceFurthestValuePosition(
        firstViewportIdx,
        endViewportIdx - 1,
        rowIdx
      );
    }

    // If we can't reuse any existing position, create a new one
    if (rowPosition === null) {
      rowPosition = bufferSet.getNewPositionForValue(rowIdx);
    }

    bufferMapping[rowPosition] = rowIdx;
  }

  state.rowHeights = rowOffsetsCache;
  state.rows = bufferMapping;
}