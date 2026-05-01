import { Animation, AnimationGroup, Quaternion, TransformNode, Vector3 } from '@babylonjs/core'
import { FBXReaderNode } from 'fbx-parser'
import { IFBXConnections } from '../connections'
import { IFBXLoaderRuntime } from '../loader'

interface IFBXAnimationOnlyModel {
  id: number
  name: string
  type: string
  lclTranslation: Vector3
  lclRotation: Vector3
  preRotation?: Vector3
  postRotation?: Vector3
}

interface IFBXAnimationOnlyCurve {
  times: number[]
  values: number[]
}

interface IFBXAnimationOnlyAxisCurves {
  x?: IFBXAnimationOnlyCurve
  y?: IFBXAnimationOnlyCurve
  z?: IFBXAnimationOnlyCurve
}

const FBX_ANIMATION_FRAME_RATE = 30

function fbxName(raw: string): string {
  return raw.includes('::') ? raw.slice(raw.lastIndexOf('::') + 2) : raw
}

function propVector(model: FBXReaderNode, propName: string): Vector3 | undefined {
  const props = model.node('Properties70')?.nodes('P') ?? []
  const p = props.find((node) => node.prop(0, 'string') === propName)
  if (!p) return undefined
  return new Vector3(p.prop(4, 'number') ?? 0, p.prop(5, 'number') ?? 0, p.prop(6, 'number') ?? 0)
}

function radians(v: Vector3 | undefined): Vector3 | undefined {
  return v ? new Vector3(v.x * Math.PI / 180, v.y * Math.PI / 180, v.z * Math.PI / 180) : undefined
}

function parseModels(objects: FBXReaderNode): Map<number, IFBXAnimationOnlyModel> {
  const out = new Map<number, IFBXAnimationOnlyModel>()
  for (const node of objects.nodes('Model')) {
    const id = node.prop(0, 'number')
    const rawName = node.prop(1, 'string')
    const type = node.prop(2, 'string')
    if (id === undefined || !rawName || !type) continue
    out.set(id, {
      id,
      name: fbxName(rawName),
      type,
      lclTranslation: propVector(node, 'Lcl Translation') ?? Vector3.Zero(),
      lclRotation: radians(propVector(node, 'Lcl Rotation')) ?? Vector3.Zero(),
      preRotation: radians(propVector(node, 'PreRotation')),
      postRotation: radians(propVector(node, 'PostRotation')),
    })
  }
  return out
}

function parseCurveNodes(objects: FBXReaderNode): Map<number, string> {
  const curveNodes = new Map<number, string>()
  for (const node of objects.nodes('AnimationCurveNode')) {
    const id = node.prop(0, 'number')
    const name = node.prop(1, 'string')
    if (id !== undefined && name) curveNodes.set(id, fbxName(name))
  }
  return curveNodes
}

function parseCurves(objects: FBXReaderNode): Map<number, IFBXAnimationOnlyCurve> {
  const out = new Map<number, IFBXAnimationOnlyCurve>()
  for (const node of objects.nodes('AnimationCurve')) {
    const id = node.prop(0, 'number')
    const keyTimes = node.node('KeyTime')?.prop(0, 'number[]')
    const values = node.node('KeyValueFloat')?.prop(0, 'number[]')
    if (id === undefined || !keyTimes?.length || !values?.length) continue
    out.set(id, {
      times: keyTimes.map((t) => t / 46186158000),
      values,
    })
  }
  return out
}

function curvesByAnimationNode(
  connections: Map<number, IFBXConnections>,
  curves: Map<number, IFBXAnimationOnlyCurve>,
  curveNodes: Map<number, string>,
): Map<number, IFBXAnimationOnlyAxisCurves> {
  const curvesByNode = new Map<number, IFBXAnimationOnlyAxisCurves>()
  for (const [curveId, curve] of curves) {
    const parent = connections.get(curveId)?.parents.find((p) => curveNodes.has(p.id))
    if (!parent?.relationship) continue
    const axis = /X$/i.test(parent.relationship) ? 'x'
      : /Y$/i.test(parent.relationship) ? 'y'
        : /Z$/i.test(parent.relationship) ? 'z'
          : null
    if (!axis) continue
    const axisCurves = curvesByNode.get(parent.id) ?? {}
    axisCurves[axis] = curve
    curvesByNode.set(parent.id, axisCurves)
  }
  return curvesByNode
}

function unionTimes(curves: IFBXAnimationOnlyAxisCurves): number[] {
  const set = new Set<number>()
  for (const curve of [curves.x, curves.y, curves.z]) {
    for (const time of curve?.times ?? []) set.add(time)
  }
  return [...set].sort((a, b) => a - b)
}

function sameTime(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-7
}

function exactCurveValue(curve: IFBXAnimationOnlyCurve | undefined, time: number): number | undefined {
  if (!curve) return undefined
  const index = curve.times.findIndex((candidate) => sameTime(candidate, time))
  return index >= 0 ? curve.values[index] : undefined
}

function animationFrameAt(timeSeconds: number): number {
  return timeSeconds * FBX_ANIMATION_FRAME_RATE
}

function vectorStepKeys(times: number[], axisCurves: IFBXAnimationOnlyAxisCurves, initialValue: Vector3): Array<{ frame: number; value: Vector3 }> {
  const previous = initialValue.clone()
  return times.map((time) => {
    const x = exactCurveValue(axisCurves.x, time)
    const y = exactCurveValue(axisCurves.y, time)
    const z = exactCurveValue(axisCurves.z, time)
    if (x !== undefined) previous.x = x
    if (y !== undefined) previous.y = y
    if (z !== undefined) previous.z = z
    return { frame: animationFrameAt(time), value: previous.clone() }
  })
}

function finalRotationQuaternionFromVector(rotation: Vector3): Quaternion {
  return Quaternion.Inverse(
    Quaternion.RotationAxis(Vector3.Left(), rotation.x)
      .multiply(Quaternion.RotationAxis(Vector3.Up(), rotation.y))
      .multiply(Quaternion.RotationAxis(Vector3.Forward(), rotation.z)),
  ).normalize()
}

function finalRotationQuaternion(rotation: Vector3, model: IFBXAnimationOnlyModel): Quaternion {
  let q = finalRotationQuaternionFromVector(rotation)
  if (model.preRotation) q = finalRotationQuaternionFromVector(model.preRotation).multiply(q)
  if (model.postRotation) q = q.multiply(Quaternion.Inverse(finalRotationQuaternionFromVector(model.postRotation)))
  return q.normalize()
}

function quaternionDot(a: Quaternion, b: Quaternion): number {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
}

function unrollQuaternion(value: Quaternion, previous: Quaternion | null): Quaternion {
  if (previous && quaternionDot(previous, value) < 0) {
    return new Quaternion(-value.x, -value.y, -value.z, -value.w)
  }
  return value
}

function rotationKeys(times: number[], axisCurves: IFBXAnimationOnlyAxisCurves, model: IFBXAnimationOnlyModel): Array<{ frame: number; value: Quaternion }> {
  const previousDegrees = new Vector3(model.lclRotation.x * 180 / Math.PI, model.lclRotation.y * 180 / Math.PI, model.lclRotation.z * 180 / Math.PI)
  let previousQuaternion: Quaternion | null = null
  return times.map((time) => {
    const x = exactCurveValue(axisCurves.x, time)
    const y = exactCurveValue(axisCurves.y, time)
    const z = exactCurveValue(axisCurves.z, time)
    if (x !== undefined) previousDegrees.x = x
    if (y !== undefined) previousDegrees.y = y
    if (z !== undefined) previousDegrees.z = z
    const value = unrollQuaternion(finalRotationQuaternion(new Vector3(
      previousDegrees.x * Math.PI / 180,
      previousDegrees.y * Math.PI / 180,
      previousDegrees.z * Math.PI / 180,
    ), model), previousQuaternion)
    previousQuaternion = value
    return { frame: animationFrameAt(time), value }
  })
}

function addAnimationForTarget(
  group: AnimationGroup,
  relationship: string | undefined,
  model: IFBXAnimationOnlyModel,
  axisCurves: IFBXAnimationOnlyAxisCurves,
  target: TransformNode,
): boolean {
  const times = unionTimes(axisCurves)
  if (!times.length) return false
  if (relationship === 'Lcl Translation') {
    const animation = new Animation(`${model.name}.position`, 'position', FBX_ANIMATION_FRAME_RATE, Animation.ANIMATIONTYPE_VECTOR3, Animation.ANIMATIONLOOPMODE_CYCLE)
    animation.setKeys(vectorStepKeys(times, axisCurves, model.lclTranslation))
    group.addTargetedAnimation(animation, target)
    return true
  }
  if (relationship !== 'Lcl Rotation') return false
  const animation = new Animation(`${model.name}.rotationQuaternion`, 'rotationQuaternion', FBX_ANIMATION_FRAME_RATE, Animation.ANIMATIONTYPE_QUATERNION, Animation.ANIMATIONLOOPMODE_CYCLE)
  animation.setKeys(rotationKeys(times, axisCurves, model))
  group.addTargetedAnimation(animation, target)
  return true
}

export function ImportAnimationOnly(runtime: IFBXLoaderRuntime, groupName = 'fbx-animation-only'): AnimationGroup | null {
  const models = parseModels(runtime.objects)
  const curves = parseCurves(runtime.objects)
  const curveNodes = parseCurveNodes(runtime.objects)
  const curvesByNode = curvesByAnimationNode(runtime.connections, curves, curveNodes)

  const animatedModelIds = new Set<number>()
  for (const [curveNodeId] of curveNodes) {
    const parent = runtime.connections.get(curveNodeId)?.parents.find((p) => p.relationship === 'Lcl Rotation' || p.relationship === 'Lcl Translation')
    if (parent) animatedModelIds.add(parent.id)
  }
  if (animatedModelIds.size === 0) return null

  const nodes = new Map<number, TransformNode>()
  for (const model of models.values()) {
    const shouldCreate = animatedModelIds.has(model.id) || model.type === 'Root' || model.type === 'LimbNode' || model.type === 'Null'
    if (!shouldCreate || runtime.cachedModels[model.id]) continue
    const node = new TransformNode(model.name, runtime.scene, true)
    node.id = model.id.toString()
    node.position.copyFrom(model.lclTranslation)
    node.rotationQuaternion = finalRotationQuaternion(model.lclRotation, model)
    runtime.cachedModels[model.id] = node
    runtime.result.transformNodes.push(node)
    nodes.set(model.id, node)
  }

  for (const [modelId, node] of nodes) {
    const parent = runtime.connections.get(modelId)?.parents.find((p) => runtime.cachedModels[p.id])
    const parentNode = parent ? runtime.cachedModels[parent.id] : null
    if (parentNode) node.parent = parentNode
  }

  const group = new AnimationGroup(groupName, runtime.scene)
  let added = 0
  for (const [curveNodeId] of curveNodes) {
    const parent = runtime.connections.get(curveNodeId)?.parents.find((p) => p.relationship === 'Lcl Rotation' || p.relationship === 'Lcl Translation')
    if (!parent) continue
    const model = models.get(parent.id)
    const target = runtime.cachedModels[parent.id]
    const axisCurves = curvesByNode.get(curveNodeId)
    if (!model || !(target instanceof TransformNode) || !axisCurves) continue
    if (addAnimationForTarget(group, parent.relationship, model, axisCurves, target)) added++
  }

  if (added === 0) {
    group.dispose()
    return null
  }
  group.normalize(0)
  runtime.result.animationGroups.push(group)
  return group
}
