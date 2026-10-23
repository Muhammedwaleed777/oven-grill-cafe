import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { prisma } from './lib/prisma'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 5000
const JWT_SECRET = process.env.JWT_SECRET || 'secret'

app.use(cors({ origin: 'http://localhost:3000', credentials: true }))
app.use(express.json())

// ─── 1. TEST ROUTE ──────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, message: 'Backend is running!' })
})

// ─── 2. REGISTER ────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, phone, password, role } = req.body
    if (!name || !phone || !password) return res.status(400).json({ error: 'All fields required' })

    const existingUser = await prisma.user.findUnique({ where: { phone } })
    if (existingUser) return res.status(400).json({ error: 'Phone number already registered' })

    const passwordHash = await bcrypt.hash(password, 10)
    const userRole = role || 'CUSTOMER'
    const status = userRole === 'CUSTOMER' ? 'APPROVED' : 'PENDING'

    const newUser = await prisma.user.create({
      data: { name, phone, passwordHash, role: userRole, status }
    })

    res.status(201).json({
      message: 'User registered successfully',
      user: { id: newUser.id, name: newUser.name, role: newUser.role, status: newUser.status }
    })
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

// ─── 3. LOGIN (With Activity Time) ──────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { phone, password } = req.body
    const user = await prisma.user.findUnique({ where: { phone } })
    
    if (!user) return res.status(401).json({ error: 'Invalid credentials' })
    const isValidPassword = await bcrypt.compare(password, user.passwordHash)
    if (!isValidPassword) return res.status(401).json({ error: 'Invalid credentials' })
    if (user.status !== 'APPROVED') return res.status(403).json({ error: `Account ${user.status}. Wait for approval.` })

    // Login time save
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() }
    })

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '7d' })
    res.json({ message: 'Login successful', token, user: { id: user.id, name: user.name, role: user.role } })
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

// ─── 4. MIDDLEWARE: AUTHENTICATE ────────────────────────────
const authenticate = (req: any, res: any, next: any) => {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'No token provided' })
  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    req.user = decoded
    next()
  } catch (error) { res.status(401).json({ error: 'Invalid token' }) }
}

// ─── 5. LOGOUT ──────────────────────────────────────────────
app.post('/api/auth/logout', authenticate, async (req: any, res) => {
  try {
    await prisma.user.update({
      where: { id: req.user.id },
      data: { lastLogout: new Date() }
    })
    res.json({ message: 'Logged out successfully' })
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

// ─── 6. ADMIN: GET ALL STAFF ────────────────────────────────
app.get('/api/admin/staff', authenticate, async (req: any, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' })
  try {
    const staff = await prisma.user.findMany({
      where: { role: { in: ['STAFF', 'CHEF', 'RIDER', 'CASHIER'] } },
      select: { id: true, name: true, phone: true, role: true, status: true, lastLogin: true, lastLogout: true }
    })
    res.json(staff)
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

// ─── 7. ADMIN: APPROVE USER ─────────────────────────────────
app.patch('/api/admin/approve-user/:id', authenticate, async (req: any, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' })
  try {
    const updatedUser = await prisma.user.update({
      where: { id: req.params.id },
      data: { status: 'APPROVED' }
    })
    res.json({ message: 'User approved', user: updatedUser })
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

// ─── 8. PUBLIC: GET MENU ────────────────────────────────────
app.get('/api/menu', async (req, res) => {
  try {
    const menu = await prisma.menuItem.findMany({
      include: { category: true },
      where: { isAvailable: true }
    })
    res.json(menu)
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

// ─── 9. ADMIN: MENU MANAGEMENT ──────────────────────────────
app.get('/api/admin/menu', authenticate, async (req: any, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' })
  try {
    const menu = await prisma.menuItem.findMany({ orderBy: { createdAt: 'desc' } })
    res.json(menu)
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

app.post('/api/admin/menu', authenticate, async (req: any, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' })
  try {
    const { name, description, price, categoryId, imageUrl } = req.body
    let catId = categoryId
    if (!catId) {
      const defaultCat = await prisma.category.upsert({
        where: { name: 'Fast Food' }, update: {}, create: { name: 'Fast Food' }
      })
      catId = defaultCat.id
    }
    const newItem = await prisma.menuItem.create({
      data: { name, description, price: Number(price), categoryId: catId, imageUrl }
    })
    res.json({ message: 'Item added', item: newItem })
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

app.patch('/api/admin/menu/:id', authenticate, async (req: any, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' })
  try {
    const { name, description, price, isAvailable, imageUrl } = req.body
    const updatedItem = await prisma.menuItem.update({
      where: { id: req.params.id },
      data: { name, description, price: Number(price), isAvailable, imageUrl }
    })
    res.json(updatedItem)
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

app.delete('/api/admin/menu/:id', authenticate, async (req: any, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' })
  try {
    await prisma.menuItem.delete({ where: { id: req.params.id } })
    res.json({ message: 'Item deleted' })
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

// ─── 10. DEALS MANAGEMENT ───────────────────────────────────
app.get('/api/admin/deals', authenticate, async (req: any, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' })
  try {
    const deals = await prisma.deal.findMany({ orderBy: { createdAt: 'desc' } })
    res.json(deals)
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

app.post('/api/admin/deals', authenticate, async (req: any, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' })
  try {
    const { title, description, price, imageUrl } = req.body
    const newDeal = await prisma.deal.create({
      data: { title, description, price: Number(price), imageUrl }
    })
    res.json(newDeal)
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

app.patch('/api/admin/deals/:id', authenticate, async (req: any, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' })
  try {
    const { title, description, price, isActive, imageUrl } = req.body
    const updatedDeal = await prisma.deal.update({
      where: { id: req.params.id },
      data: { title, description, price: Number(price), isActive, imageUrl }
    })
    res.json(updatedDeal)
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

app.delete('/api/admin/deals/:id', authenticate, async (req: any, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' })
  try {
    await prisma.deal.delete({ where: { id: req.params.id } })
    res.json({ message: 'Deal deleted' })
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

app.get('/api/deals', async (req, res) => {
  try {
    const deals = await prisma.deal.findMany({ where: { isActive: true }, orderBy: { createdAt: 'desc' } })
    res.json(deals)
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

// ─── 11. ORDERS SYSTEM (Deals fix ke sath) ──────────────────
app.post('/api/orders', async (req, res) => {
  try {
    const { customerName, customerPhone, type, address, paymentMethod, items } = req.body
    if (!items || items.length === 0) return res.status(400).json({ error: 'Cart is empty' })

    let subtotal = 0
    const orderItemsData = []

    for (const item of items) {
      // 1. Pehle Menu mein dhoonden
      let dbItem = await prisma.menuItem.findUnique({ where: { id: item.id } })
      
      // 2. Agar Menu mein na mile, to Deal mein dhoonden (VIP Deal fix)
      if (!dbItem) {
        const dealItem = await prisma.deal.findUnique({ where: { id: item.id } })
        if (dealItem) {
          dbItem = { id: dealItem.id, name: dealItem.title, price: dealItem.price } as any
        }
      }

      if (!dbItem) return res.status(400).json({ error: `Item ${item.name} not found` })

      subtotal += dbItem.price * item.qty
      orderItemsData.push({ menuItemId: dbItem.id, name: dbItem.name, price: dbItem.price, qty: item.qty })
    }

        const gstAmount = 0
    const total = subtotal
    const orderNumber = `OGC-${Math.floor(1000 + Math.random() * 9000)}`

    const newOrder = await prisma.order.create({
      data: { orderNumber, customerName, customerPhone, type, address, paymentMethod, subtotal, gstAmount, total, items: { create: orderItemsData } },
      include: { items: true }
    })
    res.status(201).json({ message: 'Order placed', order: newOrder })
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

app.get('/api/admin/orders', authenticate, async (req: any, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' })
  try {
    const orders = await prisma.order.findMany({ include: { items: true }, orderBy: { createdAt: 'desc' } })
    res.json(orders)
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id }, include: { items: true } })
    if (!order) return res.status(404).json({ error: 'Order not found' })
    res.json(order)
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

app.get('/api/bill/:orderId', async (req, res) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.orderId }, include: { items: true } })
    if (!order) return res.status(404).json({ error: 'Bill not found' })
    res.json({
      restaurantName: "Oven Grill Cafe", orderNumber: order.orderNumber, date: order.createdAt,
      customer: { name: order.customerName, phone: order.customerPhone },
      items: order.items, subtotal: order.subtotal, gst: order.gstAmount, total: order.total
    })
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

// ─── 12. ADMIN: STATS ───────────────────────────────────────
app.get('/api/admin/stats', authenticate, async (req: any, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' })
  try {
    const { start, end } = req.query
    const allOrders = await prisma.order.findMany({ where: { status: { not: 'CANCELLED' } } })
    
    let filteredOrders = allOrders
    if (start && end) {
      const startDate = new Date(start as string); startDate.setHours(0, 0, 0, 0)
      const endDate = new Date(end as string); endDate.setHours(23, 59, 59, 999)
      filteredOrders = allOrders.filter(o => {
        const oDate = new Date(o.createdAt)
        return oDate >= startDate && oDate <= endDate
      })
    }

    const totalSales = filteredOrders.reduce((sum, order) => sum + order.total, 0)
    const totalOrders = filteredOrders.length
    const today = new Date()
    const todayString = today.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
    const dailySales = allOrders.filter(o => new Date(o.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) === todayString).reduce((sum, o) => sum + o.total, 0)

    const chartMap: Record<string, number> = {}
    if (start && end) {
      let currentDate = new Date(start as string)
      const finalDate = new Date(end as string)
      while (currentDate <= finalDate) {
        const dateString = currentDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
        chartMap[dateString] = 0
        currentDate.setDate(currentDate.getDate() + 1)
      }
      filteredOrders.forEach(order => {
        const orderDate = new Date(order.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
        if (chartMap[orderDate] !== undefined) chartMap[orderDate] += order.total
      })
    }
    const chartData = Object.keys(chartMap).map(date => ({ date, sales: chartMap[date] }))
    res.json({ totalSales, totalOrders, dailySales, chartData })
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

// ─── 13. ROLE SPECIFIC APIS (Chef, Rider, Staff, Cashier) ───
app.get('/api/chef/orders', authenticate, async (req: any, res) => {
  try {
    const orders = await prisma.order.findMany({ where: { status: { in: ['PLACED', 'COOKING', 'READY'] } }, include: { items: true }, orderBy: { createdAt: 'asc' } })
    res.json(orders)
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

app.patch('/api/chef/orders/:id/status', authenticate, async (req: any, res) => {
  try {
    const updatedOrder = await prisma.order.update({ where: { id: req.params.id }, data: { status: req.body.status } })
    res.json(updatedOrder)
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

app.get('/api/staff/orders', authenticate, async (req: any, res) => {
  try {
    const orders = await prisma.order.findMany({ where: { type: { in: ['DINE_IN', 'TAKEAWAY'] }, status: { in: ['READY', 'SERVED'] } }, include: { items: true }, orderBy: { createdAt: 'asc' } })
    res.json(orders)
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

app.patch('/api/staff/orders/:id/status', authenticate, async (req: any, res) => {
  try {
    const updatedOrder = await prisma.order.update({ where: { id: req.params.id }, data: { status: req.body.status } })
    res.json(updatedOrder)
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

app.get('/api/rider/orders', authenticate, async (req: any, res) => {
  try {
    const orders = await prisma.order.findMany({ where: { type: 'DELIVERY', status: { in: ['READY', 'PICKED_UP', 'ON_THE_WAY'] } }, include: { items: true }, orderBy: { createdAt: 'asc' } })
    res.json(orders)
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

app.patch('/api/rider/orders/:id/status', authenticate, async (req: any, res) => {
  try {
    const updatedOrder = await prisma.order.update({ where: { id: req.params.id }, data: { status: req.body.status } })
    res.json(updatedOrder)
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

// ─── 14. RIDER LIVE TRACKING & NOTIFICATION ─────────────────
app.patch('/api/rider/orders/:id/location', authenticate, async (req: any, res) => {
  if (req.user.role !== 'RIDER') return res.status(403).json({ error: 'Rider only' })
  try {
    const { lat, lng } = req.body
    const updatedOrder = await prisma.order.update({
      where: { id: req.params.id },
      data: { riderLat: lat, riderLng: lng }
    })
    res.json({ message: 'Location updated', order: updatedOrder })
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

app.post('/api/rider/orders/:id/complete', authenticate, async (req: any, res) => {
  if (req.user.role !== 'RIDER') return res.status(403).json({ error: 'Rider only' })
  try {
    const order = await prisma.order.update({
      where: { id: req.params.id },
      data: { status: 'DELIVERED' }
    })
    console.log(`🔔 NOTIFICATION: Order ${order.orderNumber} delivered to ${order.customerPhone}`)
    res.json({ message: 'Order delivered & notified', order })
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

// ─── 15. CASHIER APIS ───────────────────────────────────────
app.get('/api/cashier/orders', authenticate, async (req: any, res) => {
  try {
    const orders = await prisma.order.findMany({ include: { items: true }, orderBy: { createdAt: 'desc' } })
    res.json(orders)
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

app.patch('/api/cashier/orders/:id/pay', authenticate, async (req: any, res) => {
  try {
    const updatedOrder = await prisma.order.update({ where: { id: req.params.id }, data: { paymentStatus: 'PAID' } })
    res.json(updatedOrder)
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

// ─── 16. STOCK MANAGEMENT ───────────────────────────────────
app.get('/api/admin/stock', authenticate, async (req: any, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' })
  try {
    const stock = await prisma.stockItem.findMany({ orderBy: { name: 'asc' } })
    res.json(stock)
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

app.post('/api/admin/stock', authenticate, async (req: any, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' })
  try {
    const { name, quantity, unit, minThreshold } = req.body
    const newItem = await prisma.stockItem.create({
      data: { name, quantity: Number(quantity), unit, minThreshold: Number(minThreshold) }
    })
    res.json(newItem)
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

app.patch('/api/admin/stock/:id', authenticate, async (req: any, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' })
  try {
    const { quantity } = req.body
    const updated = await prisma.stockItem.update({
      where: { id: req.params.id },
      data: { quantity: Number(quantity) }
    })
    res.json(updated)
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

app.delete('/api/admin/stock/:id', authenticate, async (req: any, res) => {
  if (req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Admin only' })
  try {
    await prisma.stockItem.delete({ where: { id: req.params.id } })
    res.json({ message: 'Item deleted' })
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})
// ─── 47. PUBLIC: TRACK ORDER BY NUMBER ──────────────────────
app.get('/api/track-order/:orderNumber', async (req, res) => {
  try {
    const { orderNumber } = req.params
    const order = await prisma.order.findUnique({
      where: { orderNumber },
      include: { items: true }
    })

    if (!order) return res.status(404).json({ error: 'Order not found. Please check your Order Number.' })
    
    res.json(order)
  } catch (error: any) { res.status(500).json({ error: error.message }) }
})

// ─── START SERVER ───────────────────────────────────────────
const PORT = process.env.PORT || 5000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`)
})