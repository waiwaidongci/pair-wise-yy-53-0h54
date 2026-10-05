'use client'

import { useMemo, useState } from 'react'
import {
  Badge, Box, Button, Card, CardBody, Divider, Flex, Grid, Heading, HStack, Input,
  Select, Stack, Switch, Tabs, TabList, Tab, TabPanels, TabPanel, Tag, Text, Textarea, useToast,
} from '@chakra-ui/react'
import { trpc } from '@/trpc/client'
import { useRightsStore, useChains } from '@/store/rights'
import { orphanChildren } from '@/lib/chains'
import type { ChainConclusion, LicenseChain, LicenseWindow, SublicenseNode, SublicenseStatus, Territory } from '@/lib/types'

const TERRITORIES: Territory[] = ['中国大陆', '中国香港', '中国台湾', '新加坡', '马来西亚', '东南亚区域', '北美']

function statusColor(status: SublicenseStatus): string {
  if (status === '生效中') return 'green'
  if (status === '草稿-冲突') return 'orange'
  if (status === '待核验') return 'yellow'
  return 'red'
}

function conclusionColor(conclusion: ChainConclusion): string {
  if (conclusion === '有效') return 'green'
  if (conclusion === '待核验') return 'yellow'
  return 'red'
}

/* -------------------------------- 次级登记表单 -------------------------------- */

function RegisterForm({ parent }: { parent: LicenseWindow }) {
  const toast = useToast()
  const localRegister = useRightsStore((state) => state.registerSub)
  const [subChannel, setSubChannel] = useState('')
  const [territory, setTerritory] = useState<Territory>(parent.territory)
  const [start, setStart] = useState(parent.start)
  const [end, setEnd] = useState(parent.end)
  const [exclusive, setExclusive] = useState(false)
  const [note, setNote] = useState('')
  const enabled = parent.sublicense

  function submit() {
    if (!subChannel.trim()) return toast({ title: '请填写下游渠道名称', status: 'warning' })
    // 本地即时硬校验（开着转授权才能登记，日期/地区/独占不得越界）
    const result = localRegister({ parentWindowId: parent.id, subChannel, territory, start, end, exclusive, note })
    if (!result.ok) return toast({ title: '登记被规则拦截', description: result.message, status: 'error' })
    toast({ title: '已登记到授权链', description: result.message, status: 'success' })
    setSubChannel(''); setNote('')
  }

  return (
    <Box>
      {!enabled && (
        <Box p={3} mb={3} bg="red.50" borderLeft="3px solid" borderLeftColor="red.500" borderRadius="4px">
          <Text fontSize="sm" fontWeight="700">母窗口已关闭转授权</Text>
          <Text fontSize="xs" color="gray.600" mt={1}>只有重新开启转授权后才能登记次级窗口；关闭期间整条授权链失效。</Text>
        </Box>
      )}
      <Grid templateColumns="1fr 1fr" gap={3}>
        <Box gridColumn="span 2">
          <Text fontSize="xs" color="gray.500" mb={1}>下游渠道 *</Text>
          <Input size="sm" value={subChannel} placeholder="例如：云帆视频·联合运营专区" onChange={(e) => setSubChannel(e.target.value)} />
        </Box>
        <Box>
          <Text fontSize="xs" color="gray.500" mb={1}>开始日期（不早于母窗口 {parent.start}）</Text>
          <Input size="sm" type="date" value={start} min={parent.start} max={parent.end} onChange={(e) => setStart(e.target.value)} />
        </Box>
        <Box>
          <Text fontSize="xs" color="gray.500" mb={1}>结束日期（不晚于母窗口 {parent.end}）</Text>
          <Input size="sm" type="date" value={end} min={parent.start} max={parent.end} onChange={(e) => setEnd(e.target.value)} />
        </Box>
        <Box>
          <Text fontSize="xs" color="gray.500" mb={1}>地区（须包含于「{parent.territory}」）</Text>
          <Select size="sm" value={territory} onChange={(e) => setTerritory(e.target.value as Territory)}>
            {TERRITORIES.map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
        </Box>
        <Box>
          <Text fontSize="xs" color="gray.500" mb={1}>独占{parent.exclusive ? '' : '（母窗口非独占，不可选）'}</Text>
          <HStack h="32px"><Switch isChecked={exclusive} isDisabled={!parent.exclusive} onChange={(e) => setExclusive(e.target.checked)} /><Text fontSize="sm">{exclusive ? '次级独占' : '普通登记'}</Text></HStack>
        </Box>
        <Box gridColumn="span 2">
          <Text fontSize="xs" color="gray.500" mb={1}>条款备注</Text>
          <Textarea size="sm" rows={2} value={note} placeholder="例如：禁止短视频连续片段超过 3 分钟" onChange={(e) => setNote(e.target.value)} />
        </Box>
      </Grid>
      <Button size="sm" mt={3} colorScheme="blue" isDisabled={!enabled} onClick={submit}>登记次级窗口</Button>
    </Box>
  )
}

/* --------------------------------- 链上子节点行 -------------------------------- */

function SubRow({ child }: { child: SublicenseNode }) {
  const localRequeue = useRightsStore((state) => state.requeueSub)
  const toast = useToast()
  const violations = [child.violations.date, child.violations.territory, child.violations.exclusive].filter(Boolean)
  return (
    <Box pl={5} py={2} borderLeft="2px dashed" borderColor="gray.200">
      <Flex justify="space-between" align="center" wrap="wrap" gap={2}>
        <HStack>
          <Text fontSize="13px">↳ {child.subChannel}</Text>
          <Tag size="sm" variant="outline">{child.rights}</Tag>
          <Tag size="sm" variant="outline">{child.territory}</Tag>
          <Badge colorScheme={child.exclusive ? 'purple' : 'gray'}>{child.exclusive ? '独占' : '普通'}</Badge>
        </HStack>
        <Badge colorScheme={statusColor(child.status)}>{child.status}</Badge>
      </Flex>
      <Text fontSize="xs" color="gray.500" mt={1}>{child.id} · {child.start} ~ {child.end}{child.basedOnRevision ? ` · 基于 rev ${child.basedOnRevision}` : ''}</Text>
      {violations.map((text) => <Text key={text} fontSize="xs" color="red.600" mt={1}>⚠ {text}</Text>)}
      {child.status === '草稿-冲突' && (
        <Box mt={2} p={2} bg="orange.50" borderRadius="4px">
          <Text fontSize="xs" color="orange.800">{child.draftReason}</Text>
          <Button size="xs" mt={2} colorScheme="blue" variant="outline" onClick={() => {
            const result = localRequeue(child.id)
            if (!result.ok) return toast({ title: '仍超出母窗口，不能重新提交', description: result.message, status: 'error' })
            toast({ title: '草稿已重新提交并生效', description: result.message, status: 'success' })
          }}>按当前母窗口重新提交</Button>
        </Box>
      )}
    </Box>
  )
}

/* --------------------------------- 授权链卡片 --------------------------------- */

function ChainCard({ chain }: { chain: LicenseChain }) {
  const { parent, children } = chain
  const setFlag = useRightsStore((state) => state.setSublicenseFlag)
  const [showForm, setShowForm] = useState(false)
  return (
    <Card variant="outline" mb={4}>
      <CardBody p={4}>
        <Flex justify="space-between" align="flex-start" gap={3} wrap="wrap">
          <Box>
            <HStack mb={1}>
              <Heading size="sm">{parent.work} · {parent.channel}</Heading>
              <Tag size="sm" colorScheme="blue">{parent.id} · rev {parent.revision}</Tag>
              <Badge colorScheme={conclusionColor(chain.conclusion)}>链结论：{chain.conclusion}</Badge>
            </HStack>
            <Text fontSize="xs" color="gray.500">
              {parent.rights} · {parent.territory} · {parent.start} ~ {parent.end} ·
              <Badge ml={1} colorScheme={parent.exclusive ? 'purple' : 'gray'}>{parent.exclusive ? '母窗口独占' : '母窗口非独占'}</Badge>
            </Text>
          </Box>
          <HStack>
            <Text fontSize="xs" color="gray.500">转授权</Text>
            <Switch isChecked={parent.sublicense} onChange={(e) => setFlag(parent.id, e.target.checked)} />
            <Badge colorScheme={parent.sublicense ? 'green' : 'red'}>{parent.sublicense ? '开启' : '关闭·整链失效'}</Badge>
            <Button size="xs" colorScheme="blue" variant="outline" isDisabled={!parent.sublicense} onClick={() => setShowForm((v) => !v)}>{showForm ? '收起登记' : '登记次级'}</Button>
          </HStack>
        </Flex>
        {showForm && <Box mt={3} p={3} bg="gray.50" borderRadius="6px"><RegisterForm parent={parent} /></Box>}
        <Divider my={3} />
        {children.length === 0 ? (
          <Text fontSize="sm" color="gray.400" pl={5}>转授权已开启，尚无下游次级窗口登记。</Text>
        ) : (
          <Stack spacing={1}>{children.map((child) => <SubRow key={child.id} child={child} />)}</Stack>
        )}
        <HStack mt={3} pl={5} fontSize="xs" color="gray.500">
          <Text>链上节点 {children.length}</Text>
          <Text color="green.600">生效 {chain.activeCount}</Text>
          <Text color="red.600">失效 {chain.invalidCount}</Text>
          <Text color="orange.600">草稿 {chain.draftCount}</Text>
          <Text color="yellow.700">待核验 {chain.reviewCount}</Text>
        </HStack>
      </CardBody>
    </Card>
  )
}

/* --------------------------------- 登记选择器 --------------------------------- */

function RegisterPicker({ chains }: { chains: LicenseChain[] }) {
  const enabledParents = chains.filter((c) => c.parent.sublicense)
  const [parentId, setParentId] = useState(enabledParents[0]?.parent.id ?? chains[0]?.parent.id ?? '')
  const parent = chains.find((c) => c.parent.id === parentId)?.parent
  return (
    <Card variant="outline">
      <CardBody p={4}>
        <Heading size="sm" mb={1}>选择母窗口登记次级窗口</Heading>
        <Text fontSize="sm" color="gray.600" mb={4}>只有开着转授权的母窗口可以登记；次级窗口的日期、地区、独占均不得超出母窗口边界。</Text>
        <Select size="sm" maxW="480px" mb={4} value={parentId} onChange={(e) => setParentId(e.target.value)}>
          {chains.map((c) => <option key={c.parent.id} value={c.parent.id} disabled={!c.parent.sublicense}>{c.parent.id} · {c.parent.work} · {c.parent.channel} · {c.parent.rights}{c.parent.sublicense ? '' : '（转授权关闭，不可登记）'}</option>)}
        </Select>
        {parent && <RegisterForm key={parent.id} parent={parent} />}
      </CardBody>
    </Card>
  )
}

/* --------------------------------- 并发演练面板 -------------------------------- */

const DEMO_ADJUST = { start: '2026-11-20', end: '2027-03-31', territory: '中国大陆' as Territory, exclusive: true, sublicense: true }
const DEMO_REGISTER = { subChannel: '方哲代理·移动端专区', territory: '中国大陆' as Territory, start: '2027-04-15', end: '2027-09-30', exclusive: false, note: '两人同时提交的次级登记' }

function RacePanel() {
  const chains = trpc.chains.useQuery()
  const drafts = trpc.drafts.useQuery()
  const log = trpc.eventLog.useQuery()
  const race = trpc.race.useMutation()
  const resetWorld = trpc.resetWorld.useMutation()
  const requeue = trpc.requeueDraft.useMutation()
  const utils = trpc.useUtils()
  const toast = useToast()
  const [parentId, setParentId] = useState('RW-102')
  const [first, setFirst] = useState<'adjust' | 'register'>('adjust')

  const parent = chains.data?.find((c) => c.parent.id === parentId)?.parent

  async function run() {
    if (!parent) return
    try {
      await race.mutateAsync({
        parentWindowId: parentId,
        baseRevision: parent.revision,
        first,
        adjustAuthor: '发行·章宁',
        registerAuthor: '渠道·方哲',
        adjustPatch: DEMO_ADJUST,
        register: DEMO_REGISTER,
      })
      utils.invalidate()
      toast({ title: '并发提交完成', description: `先到的${first === 'adjust' ? '母窗口调整' : '次级登记'}已生效，后到方保留草稿并可看到冲突。`, status: 'success' })
    } catch (error) {
      toast({ title: '演练无法开始', description: error instanceof Error ? error.message : String(error), status: 'error' })
    }
  }

  async function reset() {
    await resetWorld.mutateAsync()
    utils.invalidate()
    race.reset()
    toast({ title: '服务端世界已重置', status: 'info' })
  }

  async function requeueDraft(draftId: string) {
    const result = await requeue.mutateAsync({ draftId })
    if (!result.ok) return toast({ title: '仍超出当前母窗口，重提被拒', description: result.message, status: 'error' })
    toast({ title: '草稿已按当前母窗口生效', description: result.message, status: 'success' })
    utils.invalidate()
  }

  const focusedChain = chains.data?.find((c) => c.parent.id === parentId)

  return (
    <Box>
      <Card variant="outline" mb={4}>
        <CardBody p={4}>
          <Heading size="sm" mb={2}>两人同时提交：母窗口调整 × 次级登记（服务端乐观锁）</Heading>
          <Text fontSize="sm" color="gray.600" mb={3}>
            双方都基于同一版本（{parent ? `rev ${parent.revision}` : '加载中'}）打开编辑。服务端按到达顺序串行处理：先到者生效并推进版本号，后到者携带的期望版本对不上，提交不会覆盖先到结果，而是保留为草稿并展示它与最新母窗口的冲突。
          </Text>
          <Grid templateColumns={{ base: '1fr', md: '1fr 1fr' }} gap={4}>
            <Box p={3} border="1px solid" borderColor="gray.200" borderRadius="6px">
              <HStack mb={2}><Badge colorScheme="blue">提交 A</Badge><Text fontWeight="700" fontSize="sm">发行·章宁 · 调整母窗口</Text></HStack>
              <Text fontSize="xs" color="gray.600">把 {parentId} 结束日缩短为 {DEMO_ADJUST.end}（次级登记的结束日 {DEMO_REGISTER.end} 将因此越界）</Text>
            </Box>
            <Box p={3} border="1px solid" borderColor="gray.200" borderRadius="6px">
              <HStack mb={2}><Badge colorScheme="teal">提交 B</Badge><Text fontWeight="700" fontSize="sm">渠道·方哲 · 登记次级</Text></HStack>
              <Text fontSize="xs" color="gray.600">登记「{DEMO_REGISTER.subChannel}」{DEMO_REGISTER.start} ~ {DEMO_REGISTER.end}</Text>
            </Box>
          </Grid>
          <HStack mt={4} wrap="wrap">
            <Text fontSize="sm">母窗口</Text>
            <Select size="sm" w="180px" value={parentId} onChange={(e) => { setParentId(e.target.value); race.reset() }}>
              {(chains.data ?? []).map((c) => <option key={c.parent.id} value={c.parent.id}>{c.parent.id} · {c.parent.channel}（rev {c.parent.revision}）</option>)}
            </Select>
            <Text fontSize="sm">谁先到：</Text>
            <Select size="sm" w="160px" value={first} onChange={(e) => setFirst(e.target.value as 'adjust' | 'register')}>
              <option value="adjust">A 母窗口调整先到</option>
              <option value="register">B 次级登记先到</option>
            </Select>
            <Button size="sm" colorScheme="blue" isLoading={race.isPending} onClick={run}>同时提交（模拟并发）</Button>
            <Button size="sm" variant="outline" onClick={reset}>重置服务端数据</Button>
          </HStack>

          {race.data && (
            <Box mt={4}>
              {[race.data.winner, race.data.loser].map((r) => (
                <Box key={`${r.kind}-${r.arrivedOrder}`} p={3} mb={2} bg={r.applied ? 'green.50' : 'orange.50'} borderLeft="3px solid" borderLeftColor={r.applied ? 'green.500' : 'orange.400'} borderRadius="4px">
                  <HStack mb={1}>
                    <Badge colorScheme={r.applied ? 'green' : 'orange'}>第 {r.arrivedOrder} 个到达 · {r.applied ? '生效' : '留草稿'}</Badge>
                    <Text fontWeight="700" fontSize="sm">{r.kind === 'adjust' ? '母窗口调整' : '次级登记'} · {r.author}</Text>
                  </HStack>
                  <Text fontSize="xs" color="gray.700">携带期望版本 rev {r.expectedRevision}，到达时服务端版本 rev {r.currentRevision}{r.draftId ? ` · 草稿号 ${r.draftId}` : ''}</Text>
                  <Text fontSize="sm" mt={1}>{r.message}</Text>
                </Box>
              ))}
              <Text fontSize="xs" color="gray.500">处理完成后授权链版本：rev {race.data.newRevision}。下方「服务端授权链」里可看到后到草稿及其越界冲突。</Text>
            </Box>
          )}
        </CardBody>
      </Card>

      <Grid templateColumns={{ base: '1fr', lg: '1fr 1fr' }} gap={4} mb={4}>
        <Card variant="outline">
          <CardBody p={4}>
            <Heading size="xs" mb={3}>服务端授权链（{parentId}）：后到草稿与冲突结论</Heading>
            {focusedChain && (
              <Box>
                <HStack mb={2}>
                  <Badge colorScheme={conclusionColor(focusedChain.conclusion)}>链结论：{focusedChain.conclusion}</Badge>
                  <Text fontSize="xs">{focusedChain.parent.start} ~ {focusedChain.parent.end}</Text>
                </HStack>
                {focusedChain.children.length === 0 && <Text fontSize="sm" color="gray.400">该链暂无次级节点。</Text>}
                {focusedChain.children.map((child) => {
                  const draft = (drafts.data ?? []).find((d) => d.nodeId === child.id)
                  return (
                    <Box key={child.id} p={2} mb={2} bg={child.status === '草稿-冲突' ? 'orange.50' : child.status === '生效中' ? 'green.50' : 'red.50'} borderRadius="6px">
                      <Flex justify="space-between" align="center">
                        <Text fontSize="xs" fontWeight="700">↳ {child.subChannel} · {child.start}~{child.end}</Text>
                        <Badge colorScheme={statusColor(child.status)}>{child.status}</Badge>
                      </Flex>
                      {child.violations.date && <Text fontSize="xs" color="red.600" mt={1}>⚠ {child.violations.date}</Text>}
                      {child.violations.territory && <Text fontSize="xs" color="red.600" mt={1}>⚠ {child.violations.territory}</Text>}
                      {child.violations.exclusive && <Text fontSize="xs" color="red.600" mt={1}>⚠ {child.violations.exclusive}</Text>}
                      {draft && <Button size="xs" mt={2} variant="outline" colorScheme="blue" isLoading={requeue.isPending} onClick={() => requeueDraft(draft.id)}>按当前母窗口重新提交草稿 {draft.id}</Button>}
                    </Box>
                  )
                })}
              </Box>
            )}
          </CardBody>
        </Card>
        <Card variant="outline">
          <CardBody p={4}>
            <Heading size="xs" mb={3}>服务端草稿箱（后到提交）</Heading>
            {(drafts.data ?? []).length === 0 && <Text fontSize="sm" color="gray.400">暂无草稿。并发演练后，后到的提交会出现在这里。</Text>}
            {(drafts.data ?? []).map((d) => (
              <Box key={d.id} p={3} mb={2} bg="orange.50" borderRadius="6px">
                <HStack mb={1}><Badge>{d.id}</Badge><Text fontSize="sm" fontWeight="700">{d.kind === 'adjust' ? '母窗口调整' : '次级登记'} · {d.author}</Text><Tag size="sm">第 {d.arrivedOrder} 到达</Tag></HStack>
                <Text fontSize="xs" color="gray.600">基于 rev {d.expectedRevision}，当前 rev {d.currentRevision}</Text>
                <Text fontSize="xs" mt={1}>{d.conflict}</Text>
                <Button size="xs" mt={2} variant="outline" colorScheme="blue" onClick={() => requeueDraft(d.id)}>按当前版本重新提交</Button>
              </Box>
            ))}
          </CardBody>
        </Card>
      </Grid>

      <Card variant="outline">
        <CardBody p={4}>
          <Heading size="xs" mb={3}>服务端到达顺序日志</Heading>
          {(log.data ?? []).map((entry, i) => (
            <HStack key={`${entry.time}-${i}`} align="flex-start" mb={2}>
              <Tag size="sm" colorScheme="gray">{entry.time}</Tag>
              <Text fontSize="xs">{entry.text}</Text>
            </HStack>
          ))}
        </CardBody>
      </Card>
    </Box>
  )
}

/* --------------------------------- 待核验面板 --------------------------------- */

function OrphanPanel() {
  const windows = useRightsStore((state) => state.windows)
  const sublicenses = useRightsStore((state) => state.sublicenses)
  const attach = useRightsStore((state) => state.attachOrphan)
  const toast = useToast()
  const [picks, setPicks] = useState<Record<string, string>>({})
  const orphans = useMemo(() => orphanChildren(sublicenses), [sublicenses])

  function bind(child: SublicenseNode) {
    const parentWindowId = picks[child.id]
    if (!parentWindowId) return toast({ title: '请先选择候选母窗口', status: 'warning' })
    const result = attach(child.id, parentWindowId)
    if (!result.ok) return toast({ title: '挂接未通过硬校验', description: result.message, status: 'error' })
    toast({ title: '已完成人工核验', description: result.message, status: 'success' })
  }

  return (
    <Card variant="outline">
      <CardBody p={4}>
        <Heading size="sm" mb={1}>留待核验的存量次级登记</Heading>
        <Text fontSize="sm" color="gray.600" mb={4}>旧系统导入时没有母窗口引用：能唯一匹配作品 / 权利类型 / 转授权开关 / 日期 / 地区 / 独占边界的已自动挂链；对不上的保留在这里，由法务人工核验归属。</Text>
        {orphans.length === 0 && <Text fontSize="sm" color="gray.400">没有待核验记录，全部存量数据已挂入授权链。</Text>}
        {orphans.map((child) => {
          const candidates = windows.filter((w) => w.workId === child.workId)
          return (
            <Box key={child.id} p={3} mb={2} border="1px solid" borderColor="yellow.200" bg="yellow.50" borderRadius="6px">
              <Flex justify="space-between" wrap="wrap" gap={2}>
                <Box>
                  <HStack><Text fontWeight="700" fontSize="sm">{child.subChannel}</Text><Badge colorScheme="yellow">待核验</Badge></HStack>
                  <Text fontSize="xs" color="gray.600" mt={1}>{child.id} · {child.work} · {child.rights} · {child.territory} · {child.start} ~ {child.end}{child.exclusive ? ' · 独占' : ''}</Text>
                  <Text fontSize="xs" color="gray.700" mt={1}>{child.note}</Text>
                </Box>
                <HStack>
                  <Select size="sm" w="230px" placeholder="选择母窗口" value={picks[child.id] ?? ''} onChange={(e) => setPicks((p) => ({ ...p, [child.id]: e.target.value }))}>
                    {candidates.map((w) => <option key={w.id} value={w.id}>{w.id} · {w.channel} · {w.rights}{w.sublicense ? '' : '（未开转授权）'}</option>)}
                  </Select>
                  <Button size="sm" colorScheme="blue" onClick={() => bind(child)}>核验挂接</Button>
                </HStack>
              </Flex>
            </Box>
          )
        })}
      </CardBody>
    </Card>
  )
}

/* ----------------------------------- 主页面 ---------------------------------- */

export default function ChainsPage() {
  const chainList = useChains()
  const sublicenses = useRightsStore((state) => state.sublicenses)
  const migrationReport = useRightsStore((state) => state.migrationReport)
  const orphanCount = useMemo(() => orphanChildren(sublicenses).length, [sublicenses])

  return (
    <Box>
      <Box mb={5}>
        <Text color="brand.600" fontSize="xs" fontWeight="bold">SUBLICENSE CHAIN</Text>
        <Heading fontSize="3xl" my={1}>母窗口 → 次级授权 → 冲突结论</Heading>
        <Text color="gray.600">开着转授权才能登记次级窗口；日期、地区、独占不得超出母窗口。母窗口范围一变，越界次级窗口立即失效；关闭转授权则整条链失效。</Text>
        {migrationReport && (
          <HStack mt={3}>
            <Badge colorScheme="blue">存量迁移</Badge>
            <Text fontSize="xs" color="gray.600">自动挂链 {migrationReport.matchedCount} 条，{migrationReport.reviewCount} 条对不上母窗口，已留待核验。</Text>
          </HStack>
        )}
      </Box>

      <HStack mb={4}>
        <Tag colorScheme="blue">授权链 {chainList.length} 条</Tag>
        <Tag colorScheme="green">生效次级 {chainList.reduce((s, c) => s + c.activeCount, 0)}</Tag>
        <Tag colorScheme="red">失效次级 {chainList.reduce((s, c) => s + c.invalidCount, 0)}</Tag>
        <Tag colorScheme="orange">冲突草稿 {chainList.reduce((s, c) => s + c.draftCount, 0)}</Tag>
        <Tag colorScheme="yellow">待核验 {orphanCount}</Tag>
      </HStack>

      <Tabs colorScheme="blue" variant="enclosed">
        <TabList>
          <Tab>授权链总览</Tab>
          <Tab>登记次级窗口</Tab>
          <Tab>并发提交演练</Tab>
          <Tab>待核验（{orphanCount}）</Tab>
        </TabList>
        <TabPanels>
          <TabPanel px={0} pt={4}>
            {chainList.map((chain) => <ChainCard key={chain.parent.id} chain={chain} />)}
          </TabPanel>
          <TabPanel px={0} pt={4}>
            <RegisterPicker chains={chainList} />
          </TabPanel>
          <TabPanel px={0} pt={4}><RacePanel /></TabPanel>
          <TabPanel px={0} pt={4}><OrphanPanel /></TabPanel>
        </TabPanels>
      </Tabs>
    </Box>
  )
}
