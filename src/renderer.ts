// ============================================================================
// Orbit — Canvas Renderer
// ============================================================================
//
// High-performance 2D Canvas renderer with:
// - Depth-based HSL color scheme with radial gradient glow
// - Semi-transparent dashed orbit paths
// - Gradient connection lines from children to parents
// - Viewport culling for off-screen nodes
// - Inverse-zoom text scaling for readable labels at any zoom level
// ============================================================================

import { ParsedGraph, OrbitPluginSettings, OrbitThemeType, OrbitTraceStyle, OrbitDirectionType, LineToParentStyle } from './types';

// ---------------------------------------------------------------------------
// Color Themes & Palettes
// ---------------------------------------------------------------------------

interface ThemeColors {
	bg: string;
	orbit: string;
	connectionStart: string;
	connectionEnd: string;
	label: string;
}

export const THEMES: Record<OrbitThemeType, ThemeColors> = {
	light: {
		bg: '#ffffff',
		orbit: 'rgba(0, 0, 0, 0.60)',
		connectionStart: 'rgba(0, 0, 0, 0.65)',
		connectionEnd: 'rgba(0, 0, 0, 0.20)',
		label: '#000000',
	},
	dark: {
		bg: '#000000',
		orbit: 'rgba(255, 255, 255, 0.60)',
		connectionStart: 'rgba(255, 255, 255, 0.65)',
		connectionEnd: 'rgba(255, 255, 255, 0.10)',
		label: '#ffffff',
	},
	celestial: {
		bg: '#0a0a1a', // Classic dark space background
		orbit: 'rgba(255, 255, 255, 0.60)',
		connectionStart: 'rgba(255, 255, 255, 0.65)',
		connectionEnd: 'rgba(255, 255, 255, 0.10)',
		label: '#ffffff',
	},
};

/**
 * Dynamic node color solver for the Celestial Theme based on the maximum depth
 * of the graph and the specific node's depth.
 */
export function getNodeColor(
	nodeId: string,
	depth: number,
	theme: OrbitThemeType,
	maxDepth: number,
	siblingIndex: number = 0
): string {
	if (theme === 'dark') {
		return '#ffffff'; // Pure White for Dark Theme
	}
	if (theme === 'light') {
		return '#5C5C5C'; // Grey
	}

	if (nodeId.startsWith('virtual-tag:')) {
		return '#0CB04E'; // Virtual Tag Node (Type 3-B) Green
	}

	// -- Celestial Theme planet override (Solar System planet colors for Type 4 nodes) --
	if (theme === 'celestial') {
		// Check if this node is Type 4
		let isType4 = false;
		if (maxDepth === 1 && depth === 1) isType4 = true;
		else if (maxDepth === 2 && depth === 1) isType4 = true;
		else if (maxDepth === 3 && depth === 2) isType4 = true;
		else if (maxDepth >= 4 && depth === 3) isType4 = true;

		if (isType4) {
			const planetColors = [
				'#0051C2',  // 1st Node (Earth blue)
				'#BE7D65',  // 2nd Node
				'#C5AB6E',  // 3rd Node (Saturn sandy yellow)
				'#5BCEE4',  // 4th Node (Neptune deep blue)
			];
			if (siblingIndex >= 0) {
				return planetColors[siblingIndex % planetColors.length]!;
			}
			return '#0051C2';
		}
	}

	// -- Standard depth colors fallback for Celestial Theme --
	const type1Colors = ['#FF969D', '#FF6880', '#FF5350'];
	const type2Colors = ['#D8FFFF', '#BDFFFF', '#93FFFF'];
	const type3Colors = ['#FFBD4B', '#FFAD4A', '#FFAA27'];
	const type4Colors = ['#0051C2', '#BE7D65', '#C5AB6E', '#5BCEE4'];

	const getType1Color = () => getRandomPaletteColor(type1Colors, nodeId, siblingIndex);
	const getType2Color = () => getRandomPaletteColor(type2Colors, nodeId, siblingIndex);
	const getType3Color = () => getRandomPaletteColor(type3Colors, nodeId, siblingIndex);
	const getType4Color = () => getRandomPaletteColor(type4Colors, nodeId, siblingIndex);

	if (maxDepth === 0) {
		return getType3Color(); // Type 3-A
	}
	if (maxDepth === 1) {
		if (depth === 0) return getType3Color(); // Type 3
		return getType4Color(); // Type 4
	}
	if (maxDepth === 2) {
		if (depth === 0) return getType3Color(); // Type 3
		if (depth === 1) return getType4Color(); // Type 4
		return '#BFBFBF'; // Type 5 (Grey)
	}
	if (maxDepth === 3) {
		if (depth === 0) return getType2Color(); // Type 2 (Skyblue)
		if (depth === 1) return getType3Color(); // Type 3
		if (depth === 2) return getType4Color(); // Type 4
		return '#BFBFBF'; // Type 5 (Grey)
	}
	// maxDepth >= 4
	if (depth === 0) return getType1Color(); // Type 1 (Red)
	if (depth === 1) return getType2Color(); // Type 2 (Skyblue)
	if (depth === 2) return getType3Color(); // Type 3
	if (depth === 3) return getType4Color(); // Type 4
	return '#BFBFBF'; // Type 5 (Grey)
}

function getRandomPaletteColor(palette: string[], nodeId: string, offset: number = 0): string {
	let hash = 0;
	for (let i = 0; i < nodeId.length; i++) {
		hash = (hash << 5) - hash + nodeId.charCodeAt(i);
		hash |= 0;
	}
	const idx = Math.abs(hash + offset) % palette.length;
	return palette[idx]!;
}
