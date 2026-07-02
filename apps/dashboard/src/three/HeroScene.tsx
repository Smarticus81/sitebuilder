import { Component, Suspense, useMemo, useRef, type ReactNode } from 'react';
import { Canvas, useFrame, type ThreeElements } from '@react-three/fiber';
import { Float, Icosahedron, MeshDistortMaterial, Sparkles } from '@react-three/drei';
import type { MotionValue } from 'framer-motion';
import * as THREE from 'three';

const NEON = '#2dd4bf';
const NEON_BRIGHT = '#5eead4';
const VIOLET = '#7c6cff';

const prefersReduced =
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * The morphing centrepiece: a distorting neon icosahedron wrapped in a faint
 * wireframe shell. Rotation + distortion react to the page scroll progress that
 * the landing page feeds in as a framer-motion MotionValue.
 */
function Core({ progress }: { progress: MotionValue<number> }) {
  const group = useRef<THREE.Group>(null);
  const shell = useRef<THREE.Mesh>(null);

  useFrame((state, delta) => {
    const p = progress.get(); // 0 → 1 over the page scroll
    const t = state.clock.elapsedTime;
    if (group.current) {
      const spin = prefersReduced ? 0 : delta;
      group.current.rotation.y += spin * 0.15;
      // Scroll tilts and turns the whole cluster.
      group.current.rotation.x = THREE.MathUtils.lerp(group.current.rotation.x, p * 1.4 - 0.2, 0.06);
      group.current.rotation.z = p * 0.6;
      const s = 1 + p * 0.25;
      group.current.scale.setScalar(s);
    }
    if (shell.current) {
      shell.current.rotation.y = -t * 0.08;
      shell.current.rotation.x = t * 0.05;
    }
  });

  return (
    <group ref={group}>
      <Float speed={prefersReduced ? 0 : 1.4} rotationIntensity={0.4} floatIntensity={0.9}>
        <Icosahedron args={[1.15, 8]}>
          <MeshDistortMaterial
            color={NEON}
            emissive={NEON_BRIGHT}
            emissiveIntensity={0.12}
            roughness={0.08}
            metalness={0.95}
            distort={prefersReduced ? 0.15 : 0.38}
            speed={prefersReduced ? 0 : 1.6}
          />
        </Icosahedron>

        {/* Faint faceted wireframe shell around the core */}
        <mesh ref={shell} scale={1.55}>
          <icosahedronGeometry args={[1.35, 1]} />
          <meshBasicMaterial color={NEON_BRIGHT} wireframe transparent opacity={0.12} />
        </mesh>
      </Float>
    </group>
  );
}

/** Camera + pointer parallax; keeps the composition alive without a controls dep. */
function Rig({ progress }: { progress: MotionValue<number> }) {
  useFrame((state) => {
    const p = progress.get();
    const px = prefersReduced ? 0 : state.pointer.x;
    const py = prefersReduced ? 0 : state.pointer.y;
    // Ease the camera toward a pointer- and scroll-influenced target.
    state.camera.position.x = THREE.MathUtils.lerp(state.camera.position.x, px * 0.9, 0.05);
    state.camera.position.y = THREE.MathUtils.lerp(state.camera.position.y, py * 0.6 - p * 0.6, 0.05);
    state.camera.position.z = THREE.MathUtils.lerp(state.camera.position.z, 5.2 - p * 1.4, 0.05);
    state.camera.lookAt(0, 0, 0);
  });
  return null;
}

/** Drifting accent shards that add depth behind the core. */
function Shards() {
  const items = useMemo<{ pos: [number, number, number]; scale: number; color: string }[]>(
    () => [
      { pos: [-3.2, 1.6, -2], scale: 0.4, color: VIOLET },
      { pos: [3.4, -1.2, -1.5], scale: 0.55, color: NEON },
      { pos: [2.6, 2.2, -3], scale: 0.3, color: NEON_BRIGHT },
      { pos: [-2.8, -1.8, -2.4], scale: 0.35, color: NEON },
    ],
    [],
  );
  return (
    <>
      {items.map((it, i) => (
        <Float key={i} speed={prefersReduced ? 0 : 2} rotationIntensity={1.5} floatIntensity={2}>
          <mesh position={it.pos} scale={it.scale}>
            <octahedronGeometry args={[1, 0]} />
            <meshStandardMaterial
              color={it.color}
              emissive={it.color}
              emissiveIntensity={0.5}
              roughness={0.2}
              metalness={0.9}
            />
          </mesh>
        </Float>
      ))}
    </>
  );
}

/**
 * WebGL isn't universal (headless browsers, locked-down GPUs, some mobile).
 * If the canvas fails to initialise we quietly fall back to the CSS backdrop
 * rather than blanking the whole page.
 */
class WebGLBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function supportsWebGL(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export function HeroCanvas({ progress }: { progress: MotionValue<number> }) {
  if (!supportsWebGL()) return null;
  return (
    <WebGLBoundary>
      <HeroCanvasInner progress={progress} />
    </WebGLBoundary>
  );
}

function HeroCanvasInner({ progress }: { progress: MotionValue<number> }) {
  const lightA = { position: [4, 3, 5] } satisfies Partial<ThreeElements['pointLight']>;
  return (
    <Canvas
      gl={{ alpha: true, antialias: true, powerPreference: 'high-performance' }}
      dpr={[1, 2]}
      camera={{ position: [0, 0, 5.2], fov: 45 }}
    >
      <Suspense fallback={null}>
        <ambientLight intensity={0.35} />
        <pointLight {...lightA} intensity={40} color={NEON_BRIGHT} distance={20} decay={2} />
        <pointLight position={[-5, -2, -3]} intensity={30} color={VIOLET} distance={20} decay={2} />
        <pointLight position={[0, 4, -2]} intensity={12} color="#ffffff" distance={18} decay={2} />

        <Core progress={progress} />
        <Shards />
        <Sparkles count={90} scale={[12, 8, 6]} size={2.4} speed={prefersReduced ? 0 : 0.35} color={NEON_BRIGHT} opacity={0.7} />

        <Rig progress={progress} />
        <fog attach="fog" args={['#06070a', 6, 14]} />
      </Suspense>
    </Canvas>
  );
}
