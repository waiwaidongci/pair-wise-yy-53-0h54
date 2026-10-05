'use client'

import { useMemo, useState } from 'react'
import { Box, Flex, Grid, Heading, Text, Badge, Button, Input, Select, Checkbox, Table, Thead, Tbody, Tr, Th, Td, useToast, HStack, Tabs, TabList, Tab, TabPanels, TabPanel, Modal, ModalOverlay, ModalContent, ModalHeader, ModalBody, ModalFooter, ModalCloseButton, useDisclosure, FormControl, FormLabel, Alert, AlertIcon } from '@chakra-ui/react'
import { useRightsStore, useConflicts } from '@/store/rights'
import type { LicenseWindow, RightsType, Territory } from '@/lib/types'
import { buildChains } from '@/lib/rules'

const territories: (Territory | '全部地区')[] = ['全部地区', '中国大陆', '中国香港', '中国台湾', '新加坡', '马来西亚', '东南亚区域', '北美']
const rightsTypes: RightsType[] = ['院线', '电视', '流媒体', '航空', '非院线']

function shiftDate(date: string, days: number): string {
  const value = new Date(date)
  value.setDate(value.getDate() + days)
  return value.toISOString().slice(0, 10)
}

const statusColor: Record<LicenseWindow['status'], string> = {
  草案: 'orange',
  冲突: 'red',
  已确认: 'green',
  已失效: 'red',
  待核验: 'purple',
}

export default function WindowsPage() {
  const windows = useRightsStore((state) => state.windows)
  const updateWindow = useRightsStore((state) => state.updateWindow)
  const batchShift = useRightsStore((state) => state.batchShift)
  const registerSecondary = useRightsStore((state) => state.registerSecondary)
  const dismissVerification = useRightsStore((state) => state.dismissVerification)
  const linkToParent = useRightsStore((state) => state.linkToParent)
  const selectedWindowId = useRightsStore((state) => state.selectedWindowId)
  const selectWindow = useRightsStore((state) => state.selectWindow)
  const selectedTerritory = useRightsStore((state) => state.selectedTerritory)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [shiftDays, setShiftDays] = useState(7)
  const toast = useToast()
  const conflicts = useConflicts()
  const filtered = useMemo(() => selectedTerritory === '全部地区' ? windows : windows.filter((item) => item.territory === selectedTerritory), [windows, selectedTerritory])
  const selected = windows.find((item) => item.id === selectedWindowId)
  const chains = useMemo(() => buildChains(windows), [windows])
  const pendingVerification = windows.filter((item) => item.needsVerification)

  // 次级授权登记
  const { isOpen, onOpen, onClose } = useDisclosure()
  const [parentId, setParentId] = useState<string | null>(null)
  const [parentRevAtOpen, setParentRevAtOpen] = useState(0)
  const [form, setForm] = useState({ channel: '', rights: '流媒体' as RightsType, territory: '中国大陆' as Territory, start: '', end: '', exclusive: false })
  const parent = windows.find((item) => item.id === parentId)

  function openRegister(win: LicenseWindow) {
    setParentId(win.id)
    setParentRevAtOpen(win.rev ?? 0)
    setForm({ channel: '', rights: '流媒体', territory: win.territory, start: win.start, end: win.end, exclusive: false })
    onOpen()
  }

  function submitRegister() {
    if (!parent) return
    if (!form.channel.trim()) return toast({ title: '请填写次级渠道', status: 'warning' })
    if (new Date(form.end) < new Date(form.start)) return toast({ title: '窗口无效', description: '结束日期不能早于开始日期。', status: 'error' })
    const result = registerSecondary(parent.id, { ...form }, parentRevAtOpen)
    if (!result.ok) {
      toast({ title: '登记被拒绝', description: result.reason, status: 'error' })
      return
    }
    if (result.concurrent) {
      toast({ title: '母窗口已被他人调整，本次登记留草稿', description: result.violations.length ? result.violations.join('；') : '先到生效：母窗口调整已先生效，次级登记保留为草稿，请核对冲突。', status: 'warning', duration: 6000, isClosable: true })
    } else if (result.violations.length) {
      toast({ title: '次级窗口超出母窗口范围，已留草稿', description: result.violations.join('；'), status: 'warning', duration: 6000, isClosable: true })
    } else {
      toast({ title: '次级授权已登记', description: `已挂载到母窗口 ${parent.id}，授权链完整。`, status: 'success' })
    }
    onClose()
  }

  function simulateConcurrentAdjust() {
    if (!parent) return
    updateWindow(parent.id, { end: shiftDate(parent.end, -20) })
    toast({ title: '已模拟他人同时调整母窗口', description: '母窗口范围已缩小，先到生效。现在提交次级登记将看到并发冲突。', status: 'info', duration: 5000, isClosable: true })
  }

  function validateAndSave() {
    if (!selected) return
    if (new Date(selected.end) < new Date(selected.start)) return toast({ title: '窗口无效', description: '结束日期不能早于开始日期。', status: 'error' })
    const collision = conflicts.find((issue) => issue.windowIds.includes(selected.id))
    updateWindow(selected.id, { status: collision ? '冲突' : '已确认' })
    toast({ title: collision ? '已保存，仍存在冲突' : '窗口已确认', description: collision?.explanation ?? '授权窗口已通过规则校验。', status: collision ? 'warning' : 'success' })
  }

  return (
    <Box>
      <Flex justify="space-between" mb={5} gap={4} direction={{ base: 'column', md: 'row' }}><Box><Text color="brand.600" fontSize="xs" fontWeight="bold">TIME × TERRITORY × CHAIN</Text><Heading fontSize="3xl" my={1}>授权窗口与授权链</Heading><Text color="gray.600">母窗口、次级授权与冲突结论串成授权链；开着转授权才能登记，日期、地区与独占均不得超出母窗口。</Text></Box><Flex gap={2}><Select maxW="150px" value={selectedTerritory} onChange={(event) => useRightsStore.setState({ selectedTerritory: event.target.value })}>{territories.map((territory) => <option key={territory}>{territory}</option>)}</Select><Button colorScheme="blue" onClick={validateAndSave}>校验并保存</Button></Flex></Flex>

      {pendingVerification.length > 0 && (
        <Alert status="warning" borderRadius="8px" mb={4} flexDirection="column" alignItems="flex-start">
          <Flex w="100%" justify="space-between" align="center"><AlertIcon /><Text fontWeight="700">有 {pendingVerification.length} 条旧数据对不上母窗口，留待核验</Text></Flex>
          <Grid templateColumns={{ base: '1fr', md: 'repeat(2,1fr)' }} gap={3} mt={3} w="100%">
            {pendingVerification.map((win) => (
              <VerificationCard key={win.id} win={win} parents={windows.filter((item) => item.sublicense)} onDismiss={() => dismissVerification(win.id)} onLink={(pid) => linkToParent(win.id, pid)} />
            ))}
          </Grid>
        </Alert>
      )}

      <Tabs colorScheme="blue" variant="enclosed">
        <TabList><Tab>窗口清单</Tab><Tab>授权链视图 {chains.some((chain) => !chain.valid) && <Badge ml={2} colorScheme="red">{chains.filter((chain) => !chain.valid).length}</Badge>}</Tab></TabList>
        <TabPanels>
          <TabPanel px={0} pt={4}>
            <Grid templateColumns={{ base: '1fr', xl: 'minmax(0,1.1fr) minmax(360px,.8fr)' }} gap={4}>
              <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" overflow="hidden">
                <Flex p={4} justify="space-between" align="center"><Heading size="md">授权窗口清单</Heading><HStack><Select size="sm" w="110px" value={shiftDays} onChange={(event) => setShiftDays(Number(event.target.value))}><option value={7}>+7 天</option><option value={14}>+14 天</option><option value={-7}>-7 天</option><option value={-14}>-14 天</option></Select><Button size="sm" onClick={() => { if (!selectedIds.length) return toast({ title: '请选择窗口', status: 'warning' }); batchShift(selectedIds, shiftDays) }}>批量调窗</Button></HStack></Flex>
                <Table size="sm"><Thead><Tr><Th w="36px"></Th><Th>作品 / 渠道</Th><Th>地区</Th><Th>开始</Th><Th>结束</Th><Th>独占</Th><Th>状态</Th></Tr></Thead><Tbody>{filtered.map((item) => <Tr key={item.id} bg={selectedWindowId === item.id ? 'blue.50' : undefined} cursor="pointer" onClick={() => selectWindow(item.id)}><Td onClick={(event) => event.stopPropagation()}><Checkbox isChecked={selectedIds.includes(item.id)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} /></Td><Td><Text fontWeight="600">{item.work}</Text><Text color="gray.500" fontSize="xs">{item.channel} · {item.id}{item.parentId ? ` · 次级 → ${item.parentId}` : ''}</Text></Td><Td>{item.territory}</Td><Td>{item.start}</Td><Td>{item.end}</Td><Td><Badge colorScheme={item.exclusive ? 'purple' : 'gray'}>{item.exclusive ? '独占' : '普通'}</Badge></Td><Td><Badge colorScheme={statusColor[item.status]}>{item.status}</Badge></Td></Tr>)}</Tbody></Table>
              </Box>
              <Box bg="white" border="1px solid" borderColor="gray.200" borderRadius="8px" p={5}>
                <Heading size="md" mb={1}>窗口条款</Heading><Text color="gray.500" fontSize="sm" mb={4}>{selected?.id ?? '请选择窗口'}</Text>
                {selected && <Grid templateColumns="1fr 1fr" gap={4}>
                  <Box gridColumn="span 2"><Text fontSize="sm" mb={1}>渠道</Text><Input value={selected.channel} onChange={(event) => updateWindow(selected.id, { channel: event.target.value })} /></Box>
                  <Box><Text fontSize="sm" mb={1}>开始日期</Text><Input type="date" value={selected.start} onChange={(event) => updateWindow(selected.id, { start: event.target.value })} /></Box>
                  <Box><Text fontSize="sm" mb={1}>结束日期</Text><Input type="date" value={selected.end} onChange={(event) => updateWindow(selected.id, { end: event.target.value })} /></Box>
                  <Box><Text fontSize="sm" mb={1}>优先顺序</Text><Input type="number" value={selected.priority} onChange={(event) => updateWindow(selected.id, { priority: Number(event.target.value) })} /></Box>
                  <Box><Text fontSize="sm" mb={1}>地区</Text><Select value={selected.territory} onChange={(event) => updateWindow(selected.id, { territory: event.target.value as Territory })}>{territories.filter((item) => item !== '全部地区').map((territory) => <option key={territory}>{territory}</option>)}</Select></Box>
                  <Checkbox isChecked={selected.exclusive} onChange={(event) => updateWindow(selected.id, { exclusive: event.target.checked })}>独占窗口</Checkbox>
                  <Checkbox isChecked={selected.sublicense} onChange={(event) => updateWindow(selected.id, { sublicense: event.target.checked })}>允许次级授权{selected.sublicense && selected.chainId === selected.id ? '（母窗口）' : ''}</Checkbox>
                </Grid>}
                {selected && conflicts.filter((issue) => issue.windowIds.includes(selected.id)).map((issue) => <Box key={issue.id} mt={4} p={3} bg={issue.severity === '高' ? 'red.50' : 'orange.50'} borderLeft="3px solid" borderLeftColor={issue.severity === '高' ? 'red.500' : 'orange.400'}><Text fontWeight="700" fontSize="sm">{issue.type}</Text><Text fontSize="sm" color="gray.600" mt={1}>{issue.explanation}</Text></Box>)}
                <Button w="100%" mt={5} colorScheme="blue" onClick={validateAndSave}>保存并重新校验</Button>
              </Box>
            </Grid>
          </TabPanel>
          <TabPanel px={0} pt={4}>
            <Grid templateColumns={{ base: '1fr', lg: 'repeat(2,1fr)' }} gap={4}>
              {chains.map((chain) => (
                <Box key={chain.root.id} bg="white" border="1px solid" borderColor={chain.valid ? 'gray.200' : 'red.300'} borderLeft="4px solid" borderLeftColor={chain.valid ? 'green.400' : 'red.500'} borderRadius="8px" p={4}>
                  <Flex justify="space-between" align="flex-start" mb={3}>
                    <Box><HStack><Text fontWeight="700">{chain.root.channel}</Text><Badge colorScheme="blue">母窗口</Badge><Badge colorScheme={chain.valid ? 'green' : 'red'}>{chain.valid ? '授权链完整' : '授权链异常'}</Badge></HStack><Text color="gray.500" fontSize="xs" mt={1}>{chain.root.work} · {chain.root.id} · {chain.root.territory} · {chain.root.start} → {chain.root.end}{chain.root.exclusive ? ' · 独占' : ''}</Text></Box>
                    <Button size="sm" colorScheme="blue" variant="outline" onClick={() => openRegister(chain.root)}>登记次级授权</Button>
                  </Flex>
                  {chain.secondaries.length === 0 ? <Text color="gray.400" fontSize="sm">暂无下游次级授权。</Text> : (
                    <Box>
                      <Text fontSize="xs" color="gray.500" mb={2}>下游次级授权（{chain.secondaries.length}）</Text>
                      {chain.secondaries.map((sec) => {
                        const issue = chain.issues.find((item) => item.windowIds.includes(sec.id))
                        return (
                          <Box key={sec.id} p={2} mb={2} bg={issue ? 'red.50' : 'gray.50'} borderRadius="6px" borderLeft={issue ? '3px solid' : undefined} borderLeftColor="red.400">
                            <Flex justify="space-between" align="center"><HStack><Text fontSize="sm" fontWeight="600">{sec.channel}</Text><Text fontSize="xs" color="gray.500">{sec.id} · {sec.territory} · {sec.start} → {sec.end}</Text></HStack><Badge size="sm" colorScheme={statusColor[sec.status]}>{sec.status}</Badge></Flex>
                            {issue && <Text fontSize="xs" color="red.600" mt={1}>{issue.explanation}</Text>}
                          </Box>
                        )
                      })}
                    </Box>
                  )}
                </Box>
              ))}
            </Grid>
          </TabPanel>
        </TabPanels>
      </Tabs>

      <Modal isOpen={isOpen} onClose={onClose} size="lg">
        <ModalOverlay />
        <ModalContent>
          <ModalHeader>登记次级授权{parent ? ` · ${parent.channel}` : ''}</ModalHeader>
          <ModalCloseButton />
          <ModalBody>
            {parent && (
              <Alert status="info" borderRadius="6px" mb={4}><AlertIcon /><Box fontSize="sm"><Text>母窗口范围：{parent.start} → {parent.end} · {parent.territory} · {parent.rights}{parent.exclusive ? ' · 独占' : ' · 非独占'}</Text><Text color="gray.500" fontSize="xs" mt={1}>开着转授权才能登记；日期、地区与独占均不得超出母窗口。</Text></Box></Alert>
            )}
            <Grid templateColumns="1fr 1fr" gap={4}>
              <FormControl gridColumn="span 2"><FormLabel fontSize="sm">次级渠道</FormLabel><Input value={form.channel} onChange={(event) => setForm({ ...form, channel: event.target.value })} placeholder="如下游流媒体/卫视/航空渠道" /></FormControl>
              <FormControl><FormLabel fontSize="sm">权利类型</FormLabel><Select value={form.rights} onChange={(event) => setForm({ ...form, rights: event.target.value as RightsType })}>{rightsTypes.map((item) => <option key={item}>{item}</option>)}</Select></FormControl>
              <FormControl><FormLabel fontSize="sm">地区</FormLabel><Select value={form.territory} onChange={(event) => setForm({ ...form, territory: event.target.value as Territory })}>{territories.filter((item) => item !== '全部地区').map((item) => <option key={item}>{item}</option>)}</Select></FormControl>
              <FormControl><FormLabel fontSize="sm">开始日期</FormLabel><Input type="date" value={form.start} onChange={(event) => setForm({ ...form, start: event.target.value })} /></FormControl>
              <FormControl><FormLabel fontSize="sm">结束日期</FormLabel><Input type="date" value={form.end} onChange={(event) => setForm({ ...form, end: event.target.value })} /></FormControl>
              <Checkbox isChecked={form.exclusive} onChange={(event) => setForm({ ...form, exclusive: event.target.checked })}>独占授权（不得超出母窗口独占范围）</Checkbox>
            </Grid>
            <Button size="sm" variant="ghost" colorScheme="orange" mt={4} onClick={simulateConcurrentAdjust}>模拟他人同时调整母窗口（先到生效）</Button>
          </ModalBody>
          <ModalFooter>
            <Button variant="ghost" mr={3} onClick={onClose}>取消</Button>
            <Button colorScheme="blue" onClick={submitRegister}>提交登记</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </Box>
  )
}

function VerificationCard({ win, parents, onDismiss, onLink }: { win: LicenseWindow; parents: LicenseWindow[]; onDismiss: () => void; onLink: (parentId: string) => void }) {
  const [pid, setPid] = useState('')
  return (
    <Box p={3} bg="white" borderRadius="6px" border="1px solid" borderColor="purple.200">
      <Flex justify="space-between"><Box><Text fontWeight="600" fontSize="sm">{win.channel}</Text><Text color="gray.500" fontSize="xs">{win.id} · {win.territory} · {win.start} → {win.end}</Text></Box><Badge colorScheme="purple">待核验</Badge></Flex>
      <Text fontSize="xs" color="gray.600" mt={1}>旧系统迁入的次级授权，未找到包含它的母窗口。</Text>
      <HStack mt={2}><Select size="sm" placeholder="挂载到母窗口" value={pid} onChange={(event) => setPid(event.target.value)}>{parents.map((p) => <option key={p.id} value={p.id}>{p.channel} · {p.id}</option>)}</Select><Button size="sm" colorScheme="purple" isDisabled={!pid} onClick={() => onLink(pid)}>挂载</Button><Button size="sm" variant="ghost" onClick={onDismiss}>独立窗口</Button></HStack>
    </Box>
  )
}
