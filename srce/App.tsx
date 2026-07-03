import { useState, useRef, useEffect } from "react";
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, PieChart, Pie, Cell
} from "recharts";

// ─── Category config ──────────────────────────────────────────────────────────
const CATEGORIES = {
  REVENUE:   { label: "Revenue",               color: "#22c55e", subcategories: ["Sales (YOCO)", "EFT Income", "Other Income"] },
  COGS:      { label: "Cost of Goods",          color: "#f97316", subcategories: ["Supplier Purchases", "Packaging"] },
  PAYROLL:   { label: "Staff & Wages",          color: "#a78bfa", subcategories: ["Wages", "Contractor Pay"] },
  GROCERIES: { label: "Groceries & Supplies",   color: "#38bdf8", subcategories: ["Supermarket", "Convenience"] },
  OPEX:      { label: "Operating Expenses",     color: "#fb923c", subcategories: ["Insurance", "Software & Subscriptions", "Printing & Courier", "Bank Fees", "Other Opex"] },
  IGNORE:    { label: "Exclude / Transfer",     color: "#94a3b8", subcategories: ["Internal Transfer", "Ignore"] },
};

// ─── Built-in categorisation rules (keyword → category/sub) ──────────────────
const BUILTIN_RULES = [
  { keywords: ["YOCO B74V9"],                                               cat: "REVENUE",   sub: "Sales (YOCO)" },
  { keywords: ["INWARD EFT", "EFT CREDIT", "MUNEER KHAN"],                 cat: "REVENUE",   sub: "EFT Income" },
  { keywords: ["BEAN THERE"],                                               cat: "COGS",      sub: "Supplier Purchases" },
  { keywords: ["NOEL BROWNIES", "SL NOEL"],                                 cat: "COGS",      sub: "Supplier Purchases" },
  { keywords: ["LIQUID CONCEPTS", "PAYFAST"],                               cat: "COGS",      sub: "Packaging" },
  { keywords: ["SERGIO DE CAMPOS", "KALDI PAYMENT"],                        cat: "PAYROLL",   sub: "Contractor Pay" },
  { keywords: ["KALDI"],  extraKeywords: ["WAGES","WAGE","THOMAS","SIYA","PETUNIA","GINA","NONDLAZI","MAZIBOKO"], cat: "PAYROLL", sub: "Wages" },
  { keywords: ["PNP", "PICK N PAY", "WOOLWORTHS", "SUPERSPAR", "CHECKERS"], cat: "GROCERIES", sub: "Supermarket" },
  { keywords: ["VALUECO"],                                                  cat: "GROCERIES", sub: "Convenience" },
  { keywords: ["SANTAM"],                                                   cat: "OPEX",      sub: "Insurance" },
  { keywords: ["CANVA"],                                                    cat: "OPEX",      sub: "Software & Subscriptions" },
  { keywords: ["SAGE"],                                                     cat: "OPEX",      sub: "Software & Subscriptions" },
  { keywords: ["POSTNET"],                                                  cat: "OPEX",      sub: "Printing & Courier" },
  { keywords: ["MONTHLY SERVICE FEE", "SERVICE FEE"],                       cat: "OPEX",      sub: "Bank Fees" },
  { keywords: ["YOCO"], extraKeywords: ["POS"],                             cat: "OPEX",      sub: "Other Opex" },
];

// ─── Rules engine: applies built-ins then learned rules ──────────────────────
function applyRules(desc, learnedRules) {
  const d = desc.toUpperCase();

  // Learned rules take priority (most-recently learned first)
  for (const rule of [...learnedRules].reverse()) {
    if (d.includes(rule.keyword.toUpperCase())) {
      return { cat: rule.cat, sub: rule.sub };
    }
  }

  // Built-in rules
  for (const rule of BUILTIN_RULES) {
    const mainMatch = rule.keywords.some(k => d.includes(k));
    if (!mainMatch) continue;
    if (rule.extraKeywords) {
      if (rule.extraKeywords.some(k => d.includes(k))) return { cat: rule.cat, sub: rule.sub };
    } else {
      return { cat: rule.cat, sub: rule.sub };
    }
  }

  return { cat: "OPEX", sub: "Other Opex" };
}

// ─── Extract a learnable keyword from a description ───────────────────────────
function extractKeyword(desc) {
  const d = desc.toUpperCase();
  // Try to grab the most meaningful token (skip generic prefixes)
  const skip = ["POS LOCAL PURCHASE", "INWARD EFT CREDIT", "OUTWARD EFT", "BACKDATED S/DEBIT", "DEBIT ORDER", "INTERNATIONAL POS PU"];
  let cleaned = d;
  for (const s of skip) cleaned = cleaned.replace(s, "").trim();
  // Take first meaningful word cluster (up to 3 words)
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 3);
  return words.join(" ").trim() || desc.slice(0, 20).toUpperCase();
}

// ─── Statement parser ─────────────────────────────────────────────────────────
function parseStatement(text, learnedRules) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  let period = "Unknown";
  for (const l of lines) {
    const m = l.match(/^Date\s+(\d{2}\/\d{2}\/\d{4})/);
    if (m) { period = m[1]; break; }
  }

  const transactions = [];
  const rowRe = /(\d{2}\/\d{2}\/\d{2})\s+(\d{2}\/\d{2}\/\d{2})\s+([\s\S]+?)\s+([-+][\d ,]+\.\d{2})\s+([\+][\d ,]+\.\d{2})/g;
  let match;
  while ((match = rowRe.exec(text)) !== null) {
    const [, postDate, transDate, desc, amtRaw, balRaw] = match;
    const amount = parseFloat(amtRaw.replace(/\s/g, "").replace(/,/g, ""));
    const balance = parseFloat(balRaw.replace(/\s/g, "").replace(/,/g, ""));
    const descClean = desc.replace(/\s+/g, " ").trim();
    const { cat, sub } = applyRules(descClean, learnedRules || []);
    transactions.push({ id: `${postDate}-${transactions.length}`, postDate, transDate, description: descClean, amount, balance, category: cat, subcategory: sub });
  }

  const feeRe = /Monthly Service Fee\s+([-][\d.]+)/g;
  while ((match = feeRe.exec(text)) !== null) {
    transactions.push({ id: `fee-${transactions.length}`, postDate: period, transDate: period, description: "Monthly Service Fee", amount: parseFloat(match[1]), balance: 0, category: "OPEX", subcategory: "Bank Fees" });
  }

  return { period, transactions };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function calcPnL(transactions) {
  const totals = {};
  for (const cat of Object.keys(CATEGORIES)) totals[cat] = 0;
  for (const t of transactions) { if (t.category && totals[t.category] !== undefined) totals[t.category] += t.amount; }
  const revenue = totals.REVENUE;
  const cogs = Math.abs(totals.COGS);
  const grossProfit = revenue - cogs;
  const expenses = Math.abs(totals.PAYROLL) + Math.abs(totals.GROCERIES) + Math.abs(totals.OPEX);
  const netProfit = grossProfit - expenses;
  return { revenue, cogs, grossProfit, expenses, netProfit, totals };
}

const fmt = n => new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR", maximumFractionDigits: 2 }).format(n);

// ── Transaction month key helper (DD/MM/YY → MM/YY) ──
function txMonthKey(transDate) {
  const parts = (transDate || "").split("/");
  if (parts.length < 3) return "Unknown";
  return `${parts[1]}/${parts[2]}`;
}

// ─── Seed data ────────────────────────────────────────────────────────────────
const SEED_MONTHS = [
  {
    id: "may2026", period: "May 2026",
    transactions: [
      { id: "m1",  postDate: "12/04/26", transDate: "11/04/26", description: "POS Local Purchase PnP Crp Irene Village IRENE", amount: -122.98, category: "GROCERIES", subcategory: "Supermarket" },
      { id: "m2",  postDate: "12/04/26", transDate: "11/04/26", description: "POS Local Purchase PnP Crp Irene Village IRENE", amount: -209.37, category: "GROCERIES", subcategory: "Supermarket" },
      { id: "m3",  postDate: "12/04/26", transDate: "11/04/26", description: "POS Local Purchase WOOLWORTHS PRETORIA", amount: -135.98, category: "GROCERIES", subcategory: "Supermarket" },
      { id: "m4",  postDate: "14/04/26", transDate: "11/04/26", description: "POS Local Purchase Postnet Irene Centurion", amount: -46.00, category: "OPEX", subcategory: "Printing & Courier" },
      { id: "m5",  postDate: "13/04/26", transDate: "13/04/26", description: "Backdated S/Debit L Nondlazi Kaldi Cart", amount: -520.00, category: "PAYROLL", subcategory: "Wages" },
      { id: "m6",  postDate: "13/04/26", transDate: "13/04/26", description: "Inward EFT Credit YOCO B74V9 120426", amount: 1568.50, category: "REVENUE", subcategory: "Sales (YOCO)" },
      { id: "m7",  postDate: "19/04/26", transDate: "18/04/26", description: "POS Local Purchase Yoco Johannesburg (terminal fee)", amount: -621.00, category: "OPEX", subcategory: "Other Opex" },
      { id: "m8",  postDate: "20/04/26", transDate: "19/04/26", description: "International POS CANVA* I04856 CANVA.COM", amount: -255.00, category: "OPEX", subcategory: "Software & Subscriptions" },
      { id: "m9",  postDate: "22/04/26", transDate: "22/04/26", description: "Inward EFT Credit MUNEER KHAN- CAPITAL", amount: 621.00, category: "REVENUE", subcategory: "EFT Income" },
      { id: "m10", postDate: "26/04/26", transDate: "25/04/26", description: "POS Local Purchase PnP Crp Irene Village IRENE", amount: -59.98, category: "GROCERIES", subcategory: "Supermarket" },
      { id: "m11", postDate: "26/04/26", transDate: "25/04/26", description: "POS Local Purchase PnP Crp Irene Village IRENE", amount: -141.36, category: "GROCERIES", subcategory: "Supermarket" },
      { id: "m12", postDate: "26/04/26", transDate: "25/04/26", description: "POS Local Purchase PnP Crp Irene Village IRENE", amount: -135.95, category: "GROCERIES", subcategory: "Supermarket" },
      { id: "m13", postDate: "26/04/26", transDate: "25/04/26", description: "POS Local Purchase PnP Crp Irene Village IRENE", amount: -78.97, category: "GROCERIES", subcategory: "Supermarket" },
      { id: "m14", postDate: "27/04/26", transDate: "26/04/26", description: "POS Local Purchase PnP Crp Irene Village IRENE", amount: -158.98, category: "GROCERIES", subcategory: "Supermarket" },
      { id: "m15", postDate: "27/04/26", transDate: "26/04/26", description: "POS Local Purchase Valueco Lifestyle Ryne Centurion", amount: -84.98, category: "GROCERIES", subcategory: "Convenience" },
      { id: "m16", postDate: "28/04/26", transDate: "26/04/26", description: "POS Local Purchase SuperSpar Ryneveld PRETORIA", amount: -61.98, category: "GROCERIES", subcategory: "Supermarket" },
      { id: "m17", postDate: "27/04/26", transDate: "27/04/26", description: "Sergio de Campos Kaldi payment", amount: -855.00, category: "PAYROLL", subcategory: "Contractor Pay" },
      { id: "m18", postDate: "27/04/26", transDate: "27/04/26", description: "Backdated S/Debit Gina Damba Kaldi Cart", amount: -616.15, category: "PAYROLL", subcategory: "Wages" },
      { id: "m19", postDate: "28/04/26", transDate: "28/04/26", description: "Inward EFT Credit YOCO B74V9 260426", amount: 3617.19, category: "REVENUE", subcategory: "Sales (YOCO)" },
      { id: "m20", postDate: "28/04/26", transDate: "28/04/26", description: "Inward EFT Credit YOCO B74V9 270426", amount: 2250.93, category: "REVENUE", subcategory: "Sales (YOCO)" },
      { id: "m21", postDate: "28/04/26", transDate: "28/04/26", description: "Outward EFT Bean There Order 2870", amount: -1412.75, category: "COGS", subcategory: "Supplier Purchases" },
      { id: "m22", postDate: "30/04/26", transDate: "30/04/26", description: "Monthly Service Fee", amount: -50.00, category: "OPEX", subcategory: "Bank Fees" },
      { id: "m23", postDate: "01/05/26", transDate: "30/04/26", description: "POS Local Purchase PnP Crp Irene Village IRENE", amount: -233.73, category: "GROCERIES", subcategory: "Supermarket" },
      { id: "m24", postDate: "01/05/26", transDate: "30/04/26", description: "POS Local Purchase Checkers Sixty60 Cape Town", amount: -197.97, category: "GROCERIES", subcategory: "Supermarket" },
      { id: "m25", postDate: "01/05/26", transDate: "01/05/26", description: "Backdated S/Debit Thomas wages 01 05 2026 Kaldi", amount: -506.50, category: "PAYROLL", subcategory: "Wages" },
    ],
  },
  {
    id: "jun2026", period: "June 2026",
    transactions: [
      { id: "j1",  postDate: "03/05/26", transDate: "30/04/26", description: "POS Local Purchase Postnet Irene Centurion", amount: -72.00, category: "OPEX", subcategory: "Printing & Courier" },
      { id: "j2",  postDate: "02/05/26", transDate: "02/05/26", description: "Debit Order SANTAM J127269158", amount: -923.93, category: "OPEX", subcategory: "Insurance" },
      { id: "j3",  postDate: "02/05/26", transDate: "02/05/26", description: "Inward EFT Credit YOCO B74V9 020526", amount: 2206.42, category: "REVENUE", subcategory: "Sales (YOCO)" },
      { id: "j4",  postDate: "03/05/26", transDate: "02/05/26", description: "POS Local Purchase PnP Crp Irene Village IRENE", amount: -163.35, category: "GROCERIES", subcategory: "Supermarket" },
      { id: "j5",  postDate: "03/05/26", transDate: "02/05/26", description: "POS Local Purchase PnP Crp Irene Village IRENE", amount: -346.69, category: "GROCERIES", subcategory: "Supermarket" },
      { id: "j6",  postDate: "03/05/26", transDate: "03/05/26", description: "Backdated S/Debit Thomas Maziboko Kaldi", amount: -1165.15, category: "PAYROLL", subcategory: "Wages" },
      { id: "j7",  postDate: "04/05/26", transDate: "03/05/26", description: "POS Local Purchase PnP Crp Irene Village IRENE", amount: -100.37, category: "GROCERIES", subcategory: "Supermarket" },
      { id: "j8",  postDate: "04/05/26", transDate: "03/05/26", description: "POS Local Purchase WOOLWORTHS PRETORIA", amount: -234.98, category: "GROCERIES", subcategory: "Supermarket" },
      { id: "j9",  postDate: "04/05/26", transDate: "03/05/26", description: "POS Local Purchase Yoco Centurion (terminal)", amount: -440.00, category: "OPEX", subcategory: "Other Opex" },
      { id: "j10", postDate: "04/05/26", transDate: "04/05/26", description: "Inward EFT Credit YOCO B74V9 030526", amount: 4088.54, category: "REVENUE", subcategory: "Sales (YOCO)" },
      { id: "j11", postDate: "04/05/26", transDate: "04/05/26", description: "Inward EFT Credit YOCO B74V9 040526", amount: 1679.77, category: "REVENUE", subcategory: "Sales (YOCO)" },
      { id: "j12", postDate: "05/05/26", transDate: "05/05/26", description: "Outward EFT Sage W72265", amount: -90.00, category: "OPEX", subcategory: "Software & Subscriptions" },
      { id: "j13", postDate: "09/05/26", transDate: "08/05/26", description: "POS Local Purchase PnP Crp Irene Village IRENE", amount: -254.73, category: "GROCERIES", subcategory: "Supermarket" },
      { id: "j14", postDate: "09/05/26", transDate: "09/05/26", description: "Outward EFT Bean There Order 2904", amount: -2587.50, category: "COGS", subcategory: "Supplier Purchases" },
      { id: "j15", postDate: "10/05/26", transDate: "10/05/26", description: "Backdated S/Debit Gina Damba 10 05 Kaldi Cart", amount: -639.70, category: "PAYROLL", subcategory: "Wages" },
      { id: "j16", postDate: "10/05/26", transDate: "10/05/26", description: "Backdated S/Debit Thomas Maziboko wage Kaldi", amount: -409.00, category: "PAYROLL", subcategory: "Wages" },
      { id: "j17", postDate: "11/05/26", transDate: "10/05/26", description: "POS Local Purchase PnP Crp Irene Village IRENE", amount: -292.12, category: "GROCERIES", subcategory: "Supermarket" },
      { id: "j18", postDate: "11/05/26", transDate: "11/05/26", description: "Outward EFT Sergio de Campos Kaldi payment", amount: -311.93, category: "PAYROLL", subcategory: "Contractor Pay" },
      { id: "j19", postDate: "11/05/26", transDate: "11/05/26", description: "Inward EFT Credit YOCO B74V9 110526", amount: 1053.30, category: "REVENUE", subcategory: "Sales (YOCO)" },
      { id: "j20", postDate: "11/05/26", transDate: "11/05/26", description: "Inward EFT Credit YOCO B74V9 100526", amount: 2321.56, category: "REVENUE", subcategory: "Sales (YOCO)" },
      { id: "j21", postDate: "16/05/26", transDate: "16/05/26", description: "Backdated S/Debit Thomas Maziboko Kaldi", amount: -595.30, category: "PAYROLL", subcategory: "Wages" },
      { id: "j22", postDate: "17/05/26", transDate: "16/05/26", description: "POS Local Purchase PnP Crp Irene Village IRENE", amount: -218.74, category: "GROCERIES", subcategory: "Supermarket" },
      { id: "j23", postDate: "17/05/26", transDate: "17/05/26", description: "Backdated S/Debit Thomas Maziboko 17May Kaldi", amount: -425.00, category: "PAYROLL", subcategory: "Wages" },
      { id: "j24", postDate: "18/05/26", transDate: "18/05/26", description: "Outward EFT Bean There Order 2918", amount: -2156.25, category: "COGS", subcategory: "Supplier Purchases" },
      { id: "j25", postDate: "18/05/26", transDate: "18/05/26", description: "Inward EFT Credit YOCO B74V9 170526", amount: 2967.41, category: "REVENUE", subcategory: "Sales (YOCO)" },
      { id: "j26", postDate: "18/05/26", transDate: "18/05/26", description: "Inward EFT Credit YOCO B74V9 180526", amount: 1494.18, category: "REVENUE", subcategory: "Sales (YOCO)" },
      { id: "j27", postDate: "19/05/26", transDate: "19/05/26", description: "Outward EFT SL Noel Brownies Kaldi Brownies", amount: -300.00, category: "COGS", subcategory: "Supplier Purchases" },
      { id: "j28", postDate: "20/05/26", transDate: "19/05/26", description: "International POS CANVA* I04886 CANVA.COM", amount: -255.00, category: "OPEX", subcategory: "Software & Subscriptions" },
      { id: "j29", postDate: "26/05/26", transDate: "23/05/26", description: "POS PAYFAST*Liquid Concepts Cape Town", amount: -963.00, category: "COGS", subcategory: "Packaging" },
      { id: "j30", postDate: "24/05/26", transDate: "24/05/26", description: "Backdated S/Debit TM Wages 23 and 24 May Kaldi", amount: -1123.50, category: "PAYROLL", subcategory: "Wages" },
      { id: "j31", postDate: "25/05/26", transDate: "24/05/26", description: "POS Local Purchase PnP Crp Irene Village IRENE", amount: -292.12, category: "GROCERIES", subcategory: "Supermarket" },
      { id: "j32", postDate: "25/05/26", transDate: "25/05/26", description: "Inward EFT Credit YOCO B74V9 240526", amount: 4534.76, category: "REVENUE", subcategory: "Sales (YOCO)" },
      { id: "j33", postDate: "25/05/26", transDate: "25/05/26", description: "Inward EFT Credit YOCO B74V9 250526", amount: 2271.51, category: "REVENUE", subcategory: "Sales (YOCO)" },
      { id: "j34", postDate: "28/05/26", transDate: "28/05/26", description: "Outward EFT SL Noel Kaldi Brownies", amount: -300.00, category: "COGS", subcategory: "Supplier Purchases" },
      { id: "j35", postDate: "29/05/26", transDate: "28/05/26", description: "POS Local Purchase PnP Crp Irene Village IRENE", amount: -894.16, category: "GROCERIES", subcategory: "Supermarket" },
      { id: "j36", postDate: "29/05/26", transDate: "28/05/26", description: "POS Local Purchase WOOLWORTHS PRETORIA", amount: -226.97, category: "GROCERIES", subcategory: "Supermarket" },
      { id: "j37", postDate: "29/05/26", transDate: "29/05/26", description: "Outward EFT Siya Wages Kaldi", amount: -660.80, category: "PAYROLL", subcategory: "Wages" },
      { id: "j38", postDate: "30/05/26", transDate: "29/05/26", description: "POS Local Purchase PnP Crp Irene Village IRENE", amount: -159.98, category: "GROCERIES", subcategory: "Supermarket" },
      { id: "j39", postDate: "30/05/26", transDate: "29/05/26", description: "POS Local Purchase Yoco Johannesburg (terminal)", amount: -356.00, category: "OPEX", subcategory: "Other Opex" },
      { id: "j40", postDate: "31/05/26", transDate: "29/05/26", description: "POS Local Purchase Postnet Irene Centurion", amount: -72.00, category: "OPEX", subcategory: "Printing & Courier" },
      { id: "j41", postDate: "30/05/26", transDate: "30/05/26", description: "Inward EFT Credit YOCO B74V9 300526", amount: 1213.55, category: "REVENUE", subcategory: "Sales (YOCO)" },
      { id: "j42", postDate: "30/05/26", transDate: "30/05/26", description: "Backdated S/Debit Petunia Wages Kaldi", amount: -744.55, category: "PAYROLL", subcategory: "Wages" },
      { id: "j43", postDate: "31/05/26", transDate: "30/05/26", description: "POS Local Purchase PnP Crp Irene Village IRENE", amount: -662.80, category: "GROCERIES", subcategory: "Supermarket" },
      { id: "j44", postDate: "31/05/26", transDate: "31/05/26", description: "Monthly Service Fee", amount: -50.00, category: "OPEX", subcategory: "Bank Fees" },
      { id: "j45", postDate: "01/06/26", transDate: "01/06/26", description: "Debit Order SANTAM J127784350", amount: -923.93, category: "OPEX", subcategory: "Insurance" },
      { id: "j46", postDate: "01/06/26", transDate: "01/06/26", description: "Backdated S/Debit Thomas Wages Kaldi", amount: -420.50, category: "PAYROLL", subcategory: "Wages" },
      { id: "j47", postDate: "01/06/26", transDate: "01/06/26", description: "Inward EFT Credit YOCO B74V9 310526", amount: 5741.57, category: "REVENUE", subcategory: "Sales (YOCO)" },
      { id: "j48", postDate: "01/06/26", transDate: "01/06/26", description: "Inward EFT Credit YOCO B74V9 010626", amount: 2702.09, category: "REVENUE", subcategory: "Sales (YOCO)" },
    ],
  },
];

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [months, setMonths] = useState(SEED_MONTHS);
  const [activeMonth, setActiveMonth] = useState("05/26"); // Apr 2026 trans month key (MM/YY)
  const [view, setView] = useState("dashboard");
  const [editingTx, setEditingTx] = useState(null);
  const [uploadStatus, setUploadStatus] = useState(null);
  const [search, setSearch] = useState("");
  const [dragging, setDragging] = useState(false);
  // Learned rules: { id, keyword, cat, sub, count, example }
  const [learnedRules, setLearnedRules] = useState([]);
  const [showRules, setShowRules] = useState(false);
  const fileRef = useRef();

  // Load PDF.js once
  useEffect(() => {
    if (window.pdfjsLib) return;
    const script = document.createElement("script");
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    script.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"; };
    document.head.appendChild(script);
  }, []);

  // ── Group ALL transactions by their transaction month (DD/MM/YY → MM/YY) ──
  const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  function txMonthLabel(mmyy) {
    const [mm, yy] = mmyy.split("/");
    const monthIdx = parseInt(mm, 10) - 1;
    return `${MONTH_NAMES[monthIdx] || mm} 20${yy}`;
  }

  // Collect and sort all unique transaction months across all statements
  const allTx = months.flatMap(m => m.transactions);
  const monthMap = {};
  for (const tx of allTx) {
    const key = txMonthKey(tx.transDate);
    if (!monthMap[key]) monthMap[key] = [];
    monthMap[key].push(tx);
  }
  const sortedMonthKeys = Object.keys(monthMap).sort((a, b) => {
    const [am, ay] = a.split("/").map(Number);
    const [bm, by] = b.split("/").map(Number);
    return ay !== by ? ay - by : am - bm;
  });
  const transByMonth = sortedMonthKeys.map(key => ({
    key,
    label: txMonthLabel(key),
    shortLabel: txMonthLabel(key).split(" ")[0],
    transactions: monthMap[key],
  }));

  // Active month for dashboard: match by transDate month key
  const activeTransMonth = transByMonth.find(m => m.key === activeMonth) || transByMonth[transByMonth.length - 1] || { key: "", label: "", shortLabel: "", transactions: [] };
  const pnl = calcPnL(activeTransMonth.transactions);

  // ── YTD aggregates (all transaction months) ──
  const ytdPnL = calcPnL(allTx);

  const trendData = transByMonth.map(m => {
    const p = calcPnL(m.transactions);
    return { name: m.shortLabel, Revenue: p.revenue, "Gross Profit": p.grossProfit, "Net Profit": p.netProfit };
  });

  // Cumulative running net profit by transaction month
  let running = 0;
  const cumulativeData = transByMonth.map(m => {
    const p = calcPnL(m.transactions);
    running += p.netProfit;
    return { name: m.shortLabel, "Cumulative Profit": parseFloat(running.toFixed(2)) };
  });

  const catBarData = transByMonth.map(m => {
    const p = calcPnL(m.transactions);
    return { name: m.shortLabel, Wages: Math.abs(p.totals.PAYROLL), COGS: Math.abs(p.totals.COGS), Groceries: Math.abs(p.totals.GROCERIES), OpEx: Math.abs(p.totals.OPEX) };
  });

  const expenseBreakdown = [
    { name: "Staff & Wages", value: Math.abs(pnl.totals.PAYROLL), color: CATEGORIES.PAYROLL.color },
    { name: "Cost of Goods", value: Math.abs(pnl.totals.COGS), color: CATEGORIES.COGS.color },
    { name: "Groceries", value: Math.abs(pnl.totals.GROCERIES), color: CATEGORIES.GROCERIES.color },
    { name: "Operating Exp.", value: Math.abs(pnl.totals.OPEX), color: CATEGORIES.OPEX.color },
  ].filter(e => e.value > 0);

  const ytdExpenseBreakdown = [
    { name: "Staff & Wages", value: Math.abs(ytdPnL.totals.PAYROLL), color: CATEGORIES.PAYROLL.color },
    { name: "Cost of Goods", value: Math.abs(ytdPnL.totals.COGS), color: CATEGORIES.COGS.color },
    { name: "Groceries", value: Math.abs(ytdPnL.totals.GROCERIES), color: CATEGORIES.GROCERIES.color },
    { name: "Operating Exp.", value: Math.abs(ytdPnL.totals.OPEX), color: CATEGORIES.OPEX.color },
  ].filter(e => e.value > 0);

  const grossMargin = pnl.revenue > 0 ? (pnl.grossProfit / pnl.revenue * 100).toFixed(1) : 0;
  const netMargin   = pnl.revenue > 0 ? (pnl.netProfit  / pnl.revenue * 100).toFixed(1) : 0;
  const ytdGrossMargin = ytdPnL.revenue > 0 ? (ytdPnL.grossProfit / ytdPnL.revenue * 100).toFixed(1) : 0;
  const ytdNetMargin   = ytdPnL.revenue > 0 ? (ytdPnL.netProfit   / ytdPnL.revenue * 100).toFixed(1) : 0;

  // ── Manual categorisation → learn rule ──
  const updateTx = (txId, changes) => {
    const tx = activeTransMonth.transactions.find(t => t.id === txId);
    if (tx && (changes.category !== tx.category || changes.subcategory !== tx.subcategory)) {
      const keyword = extractKeyword(tx.description);
      setLearnedRules(prev => {
        const existing = prev.find(r => r.keyword.toUpperCase() === keyword.toUpperCase());
        if (existing) {
          return prev.map(r => r.keyword.toUpperCase() === keyword.toUpperCase()
            ? { ...r, cat: changes.category, sub: changes.subcategory, count: r.count + 1 }
            : r);
        }
        return [...prev, { id: Date.now(), keyword, cat: changes.category, sub: changes.subcategory, count: 1, example: tx.description }];
      });
    }
    // Update the transaction across all statement months (it lives in whichever month's array it was imported into)
    setMonths(prev => prev.map(m => ({
      ...m,
      transactions: m.transactions.map(t => t.id === txId ? { ...t, ...changes } : t),
    })));
    setEditingTx(null);
  };

  const deleteRule = (id) => setLearnedRules(prev => prev.filter(r => r.id !== id));

  // ── PDF upload ──
  const extractPdfText = async (file) => {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const items = content.items.slice().sort((a, b) => {
        const yDiff = Math.round(b.transform[5]) - Math.round(a.transform[5]);
        return yDiff !== 0 ? yDiff : a.transform[4] - b.transform[4];
      });
      fullText += items.map(it => it.str).join(" ") + "\n";
    }
    return fullText;
  };

  const handleFileUpload = async (file) => {
    if (!file) return;
    if (!window.pdfjsLib) { setUploadStatus("loading"); await new Promise(r => setTimeout(r, 1500)); if (!window.pdfjsLib) { setUploadStatus("error"); return; } }
    setUploadStatus("reading");
    try {
      const text = await extractPdfText(file);
      const { period, transactions } = parseStatement(text, learnedRules);
      const newId = period.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (transactions.length === 0) { setUploadStatus("error"); return; }
      setMonths(prev => {
        const exists = prev.find(m => m.id === newId);
        if (exists) return prev.map(m => m.id === newId ? { ...m, transactions } : m);
        return [...prev, { id: newId, period, transactions }];
      });
      // Set activeMonth to the most recent transaction month key from the imported transactions
      if (transactions.length > 0) {
        const keys = transactions.map(t => txMonthKey(t.transDate)).filter(k => k !== "Unknown");
        const sorted = keys.sort((a, b) => {
          const [am, ay] = a.split("/").map(Number);
          const [bm, by] = b.split("/").map(Number);
          return ay !== by ? ay - by : am - bm;
        });
        if (sorted.length > 0) setActiveMonth(sorted[sorted.length - 1]);
      }
      setView("transactions");
      setUploadStatus("done");
      setTimeout(() => setUploadStatus(null), 3000);
    } catch (err) { console.error(err); setUploadStatus("error"); }
  };

  const handleFileInputChange = e => handleFileUpload(e.target.files[0]);
  const handleDrop = e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f?.type === "application/pdf") handleFileUpload(f); };

  const filteredTx = activeTransMonth.transactions.filter(t =>
    t.description.toLowerCase().includes(search.toLowerCase()) ||
    t.category.toLowerCase().includes(search.toLowerCase()) ||
    t.subcategory.toLowerCase().includes(search.toLowerCase())
  );

  // ── Shared styles ──
  const card = { background: "#161b27", border: "1px solid #1e2535", borderRadius: 12, padding: 20 };

  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", background: "#0f1117", minHeight: "100vh", color: "#e2e8f0" }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } } select option { background: #161b27; }`}</style>

      {/* Header */}
      <div style={{ background: "#161b27", borderBottom: "1px solid #1e2535", padding: "0 24px" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", height: 60 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 32, height: 32, background: "linear-gradient(135deg,#22c55e,#16a34a)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>☕</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15, color: "#f1f5f9", letterSpacing: "-0.3px" }}>Fiveoaks Pty Ltd</div>
              <div style={{ fontSize: 11, color: "#64748b" }}>P&L Tracker · Acc 1053842511</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
            {[["dashboard","Dashboard"],["ytd","YTD"],["transactions","Transactions"],["upload","Import"]].map(([v,label]) => (
              <button key={v} onClick={() => setView(v)} style={{ padding: "6px 14px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 500, background: view === v ? "#22c55e" : "transparent", color: view === v ? "#0f1117" : "#94a3b8" }}>
                {label}
              </button>
            ))}
            <button onClick={() => setShowRules(!showRules)} title="Learned rules" style={{ marginLeft: 8, padding: "6px 10px", borderRadius: 6, border: "1px solid #1e2535", cursor: "pointer", fontSize: 12, background: "transparent", color: learnedRules.length > 0 ? "#22c55e" : "#64748b" }}>
              🧠 {learnedRules.length}
            </button>
          </div>
        </div>
      </div>

      {/* Month tabs — grouped by transaction date month */}
      <div style={{ background: "#161b27", borderBottom: "1px solid #1e2535", padding: "0 24px" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", display: "flex", gap: 8, padding: "10px 0", flexWrap: "wrap" }}>
          {transByMonth.map(m => (
            <button key={m.key} onClick={() => setActiveMonth(m.key)} style={{ padding: "5px 14px", borderRadius: 20, border: `1px solid ${activeMonth === m.key ? "#22c55e" : "#1e2535"}`, background: activeMonth === m.key ? "rgba(34,197,94,0.12)" : "transparent", color: activeMonth === m.key ? "#22c55e" : "#64748b", cursor: "pointer", fontSize: 12, fontWeight: 500 }}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Learned Rules Panel */}
      {showRules && (
        <div style={{ background: "#0f1117", borderBottom: "1px solid #1e2535", padding: "16px 24px" }}>
          <div style={{ maxWidth: 1200, margin: "0 auto" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8", marginBottom: 12 }}>
              🧠 Learned Rules — applied automatically to future imports
              {learnedRules.length === 0 && <span style={{ color: "#475569", fontWeight: 400, marginLeft: 8 }}>None yet. Reassign a transaction to create one.</span>}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {learnedRules.map(r => (
                <div key={r.id} style={{ background: "#161b27", border: "1px solid #1e2535", borderRadius: 8, padding: "6px 12px", display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
                  <span style={{ color: "#64748b", fontFamily: "monospace" }}>{r.keyword}</span>
                  <span style={{ color: "#475569" }}>→</span>
                  <span style={{ color: CATEGORIES[r.cat]?.color, fontWeight: 600 }}>{CATEGORIES[r.cat]?.label}</span>
                  <span style={{ color: "#475569" }}>·</span>
                  <span style={{ color: "#64748b" }}>{r.sub}</span>
                  <span style={{ color: "#475569", fontSize: 10 }}>×{r.count}</span>
                  <button onClick={() => deleteRule(r.id)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 }}>✕</button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px" }}>

        {/* ── DASHBOARD ── */}
        {view === "dashboard" && (
          <div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, marginBottom: 24 }}>
              {[
                { label: "Revenue",         value: fmt(pnl.revenue),     color: "#22c55e" },
                { label: "Gross Profit",    value: fmt(pnl.grossProfit), sub: `${grossMargin}% margin`, color: pnl.grossProfit >= 0 ? "#22c55e" : "#f87171" },
                { label: "Total Expenses",  value: fmt(pnl.expenses),    color: "#f97316" },
                { label: "Net Profit",      value: fmt(pnl.netProfit),   sub: `${netMargin}% margin`, color: pnl.netProfit >= 0 ? "#22c55e" : "#f87171" },
                { label: "Transactions",    value: activeTransMonth.transactions.length, color: "#38bdf8" },
              ].map(kpi => (
                <div key={kpi.label} style={{ ...card, padding: "16px 20px" }}>
                  <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>{kpi.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: kpi.color, letterSpacing: "-0.5px" }}>{kpi.value}</div>
                  {kpi.sub && <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>{kpi.sub}</div>}
                </div>
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
              <div style={card}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8", marginBottom: 16 }}>P&L Summary · {activeTransMonth.label}</div>
                {[
                  { label: "Revenue",             value: pnl.revenue,           indent: 0, bold: false },
                  { label: "Cost of Goods Sold",  value: -pnl.totals.COGS,      indent: 1, bold: false },
                  { label: "Gross Profit",         value: pnl.grossProfit,       indent: 0, bold: true, line: true },
                  { label: "Staff & Wages",        value: pnl.totals.PAYROLL,    indent: 1, bold: false },
                  { label: "Groceries & Supplies", value: pnl.totals.GROCERIES,  indent: 1, bold: false },
                  { label: "Operating Expenses",   value: pnl.totals.OPEX,       indent: 1, bold: false },
                  { label: "Net Profit",           value: pnl.netProfit,         indent: 0, bold: true, line: true },
                ].map((row, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: `6px 0 6px ${row.indent * 16}px`, borderTop: row.line ? "1px solid #1e2535" : "none", marginTop: row.line ? 4 : 0 }}>
                    <span style={{ fontSize: 13, fontWeight: row.bold ? 600 : 400, color: row.bold ? "#f1f5f9" : "#94a3b8" }}>{row.label}</span>
                    <span style={{ fontSize: 13, fontWeight: row.bold ? 700 : 500, color: row.value >= 0 ? "#22c55e" : "#f87171", fontVariantNumeric: "tabular-nums" }}>{fmt(row.value)}</span>
                  </div>
                ))}
              </div>

              <div style={card}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8", marginBottom: 8 }}>Expense Mix · {activeTransMonth.label}</div>
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie data={expenseBreakdown} cx="50%" cy="50%" innerRadius={55} outerRadius={90} dataKey="value" paddingAngle={3}>
                      {expenseBreakdown.map((e, i) => <Cell key={i} fill={e.color} />)}
                    </Pie>
                    <Tooltip formatter={v => fmt(v)} contentStyle={{ background: "#161b27", border: "1px solid #1e2535", borderRadius: 8, color: "#e2e8f0", fontSize: 12 }} />
                    <Legend iconType="circle" iconSize={8} formatter={v => <span style={{ color: "#94a3b8", fontSize: 12 }}>{v}</span>} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>

            {months.length > 1 && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <div style={card}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8", marginBottom: 16 }}>Profit Trend</div>
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={trendData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e2535" />
                      <XAxis dataKey="name" tick={{ fill: "#64748b", fontSize: 11 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: "#64748b", fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => `R${(v/1000).toFixed(0)}k`} />
                      <Tooltip formatter={v => fmt(v)} contentStyle={{ background: "#161b27", border: "1px solid #1e2535", borderRadius: 8, color: "#e2e8f0", fontSize: 12 }} />
                      <Legend iconSize={8} formatter={v => <span style={{ color: "#94a3b8", fontSize: 11 }}>{v}</span>} />
                      <Line type="monotone" dataKey="Revenue" stroke="#22c55e" strokeWidth={2} dot={{ fill: "#22c55e", r: 4 }} />
                      <Line type="monotone" dataKey="Gross Profit" stroke="#38bdf8" strokeWidth={2} dot={{ fill: "#38bdf8", r: 4 }} />
                      <Line type="monotone" dataKey="Net Profit" stroke="#a78bfa" strokeWidth={2} dot={{ fill: "#a78bfa", r: 4 }} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
                <div style={card}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8", marginBottom: 16 }}>Expense Breakdown by Month</div>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={catBarData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e2535" />
                      <XAxis dataKey="name" tick={{ fill: "#64748b", fontSize: 11 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: "#64748b", fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => `R${(v/1000).toFixed(0)}k`} />
                      <Tooltip formatter={v => fmt(v)} contentStyle={{ background: "#161b27", border: "1px solid #1e2535", borderRadius: 8, color: "#e2e8f0", fontSize: 12 }} />
                      <Legend iconSize={8} formatter={v => <span style={{ color: "#94a3b8", fontSize: 11 }}>{v}</span>} />
                      <Bar dataKey="Wages" stackId="a" fill={CATEGORIES.PAYROLL.color} />
                      <Bar dataKey="COGS" stackId="a" fill={CATEGORIES.COGS.color} />
                      <Bar dataKey="Groceries" stackId="a" fill={CATEGORIES.GROCERIES.color} />
                      <Bar dataKey="OpEx" stackId="a" fill={CATEGORIES.OPEX.color} radius={[4,4,0,0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── YTD ── */}
        {view === "ytd" && (
          <div>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 16, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Year-to-date · {transByMonth.length} month{transByMonth.length !== 1 ? "s" : ""} · {transByMonth.map(m => m.label).join(", ")}
            </div>

            {/* YTD KPIs */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 16, marginBottom: 24 }}>
              {[
                { label: "YTD Revenue",       value: fmt(ytdPnL.revenue),     color: "#22c55e" },
                { label: "YTD Gross Profit",  value: fmt(ytdPnL.grossProfit), sub: `${ytdGrossMargin}% margin`, color: ytdPnL.grossProfit >= 0 ? "#22c55e" : "#f87171" },
                { label: "YTD Expenses",      value: fmt(ytdPnL.expenses),    color: "#f97316" },
                { label: "YTD Net Profit",    value: fmt(ytdPnL.netProfit),   sub: `${ytdNetMargin}% margin`, color: ytdPnL.netProfit >= 0 ? "#22c55e" : "#f87171" },
                { label: "Total Transactions",value: allTx.length,            color: "#38bdf8" },
              ].map(kpi => (
                <div key={kpi.label} style={{ ...card, padding: "16px 20px" }}>
                  <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.06em" }}>{kpi.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: kpi.color, letterSpacing: "-0.5px" }}>{kpi.value}</div>
                  {kpi.sub && <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>{kpi.sub}</div>}
                </div>
              ))}
            </div>

            {/* YTD P&L + pie */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
              <div style={card}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8", marginBottom: 16 }}>YTD P&L Summary</div>
                {[
                  { label: "Revenue",             value: ytdPnL.revenue,          indent: 0, bold: false },
                  { label: "Cost of Goods Sold",  value: -ytdPnL.totals.COGS,     indent: 1, bold: false },
                  { label: "Gross Profit",         value: ytdPnL.grossProfit,      indent: 0, bold: true, line: true },
                  { label: "Staff & Wages",        value: ytdPnL.totals.PAYROLL,   indent: 1, bold: false },
                  { label: "Groceries & Supplies", value: ytdPnL.totals.GROCERIES, indent: 1, bold: false },
                  { label: "Operating Expenses",   value: ytdPnL.totals.OPEX,      indent: 1, bold: false },
                  { label: "Net Profit",           value: ytdPnL.netProfit,        indent: 0, bold: true, line: true },
                ].map((row, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: `6px 0 6px ${row.indent * 16}px`, borderTop: row.line ? "1px solid #1e2535" : "none", marginTop: row.line ? 4 : 0 }}>
                    <span style={{ fontSize: 13, fontWeight: row.bold ? 600 : 400, color: row.bold ? "#f1f5f9" : "#94a3b8" }}>{row.label}</span>
                    <span style={{ fontSize: 13, fontWeight: row.bold ? 700 : 500, color: row.value >= 0 ? "#22c55e" : "#f87171", fontVariantNumeric: "tabular-nums" }}>{fmt(row.value)}</span>
                  </div>
                ))}
              </div>

              <div style={card}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8", marginBottom: 8 }}>YTD Expense Mix</div>
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie data={ytdExpenseBreakdown} cx="50%" cy="50%" innerRadius={55} outerRadius={90} dataKey="value" paddingAngle={3}>
                      {ytdExpenseBreakdown.map((e, i) => <Cell key={i} fill={e.color} />)}
                    </Pie>
                    <Tooltip formatter={v => fmt(v)} contentStyle={{ background: "#161b27", border: "1px solid #1e2535", borderRadius: 8, color: "#e2e8f0", fontSize: 12 }} />
                    <Legend iconType="circle" iconSize={8} formatter={v => <span style={{ color: "#94a3b8", fontSize: 12 }}>{v}</span>} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Month comparison + cumulative */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
              <div style={card}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8", marginBottom: 16 }}>Month-by-Month Revenue vs Profit</div>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={trendData} barCategoryGap="30%">
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e2535" />
                    <XAxis dataKey="name" tick={{ fill: "#64748b", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: "#64748b", fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => `R${(v/1000).toFixed(0)}k`} />
                    <Tooltip formatter={v => fmt(v)} contentStyle={{ background: "#161b27", border: "1px solid #1e2535", borderRadius: 8, color: "#e2e8f0", fontSize: 12 }} />
                    <Legend iconSize={8} formatter={v => <span style={{ color: "#94a3b8", fontSize: 11 }}>{v}</span>} />
                    <Bar dataKey="Revenue" fill="#22c55e" radius={[4,4,0,0]} />
                    <Bar dataKey="Gross Profit" fill="#38bdf8" radius={[4,4,0,0]} />
                    <Bar dataKey="Net Profit" fill="#a78bfa" radius={[4,4,0,0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>

              <div style={card}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8", marginBottom: 16 }}>Cumulative Net Profit</div>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={cumulativeData}>
                    <defs>
                      <linearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#22c55e" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e2535" />
                    <XAxis dataKey="name" tick={{ fill: "#64748b", fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: "#64748b", fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => `R${(v/1000).toFixed(0)}k`} />
                    <Tooltip formatter={v => fmt(v)} contentStyle={{ background: "#161b27", border: "1px solid #1e2535", borderRadius: 8, color: "#e2e8f0", fontSize: 12 }} />
                    <Area type="monotone" dataKey="Cumulative Profit" stroke="#22c55e" strokeWidth={2} fill="url(#profitGrad)" dot={{ fill: "#22c55e", r: 5 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Per-month breakdown table */}
            <div style={card}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8", marginBottom: 16 }}>Month-by-Month Breakdown</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr repeat(5, auto)", gap: 8 }}>
                {["Month", "Revenue", "COGS", "Gross Profit", "Expenses", "Net Profit"].map((h, i) => (
                  <div key={i} style={{ fontSize: 11, color: "#475569", textTransform: "uppercase", letterSpacing: "0.06em", textAlign: i > 0 ? "right" : "left", paddingBottom: 8, borderBottom: "1px solid #1e2535" }}>{h}</div>
                ))}
                {transByMonth.map(m => {
                  const p = calcPnL(m.transactions);
                  return [
                    <div key={`${m.key}-n`}  style={{ fontSize: 13, color: "#cbd5e1", paddingTop: 8 }}>{m.label}</div>,
                    <div key={`${m.key}-r`}  style={{ fontSize: 13, color: "#22c55e", textAlign: "right", fontVariantNumeric: "tabular-nums", paddingTop: 8 }}>{fmt(p.revenue)}</div>,
                    <div key={`${m.key}-c`}  style={{ fontSize: 13, color: "#f87171", textAlign: "right", fontVariantNumeric: "tabular-nums", paddingTop: 8 }}>{fmt(Math.abs(p.totals.COGS))}</div>,
                    <div key={`${m.key}-g`}  style={{ fontSize: 13, color: p.grossProfit >= 0 ? "#22c55e" : "#f87171", textAlign: "right", fontVariantNumeric: "tabular-nums", paddingTop: 8 }}>{fmt(p.grossProfit)}</div>,
                    <div key={`${m.key}-e`}  style={{ fontSize: 13, color: "#f97316", textAlign: "right", fontVariantNumeric: "tabular-nums", paddingTop: 8 }}>{fmt(p.expenses)}</div>,
                    <div key={`${m.key}-np`} style={{ fontSize: 13, fontWeight: 700, color: p.netProfit >= 0 ? "#22c55e" : "#f87171", textAlign: "right", fontVariantNumeric: "tabular-nums", paddingTop: 8 }}>{fmt(p.netProfit)}</div>,
                  ];
                })}
                {/* Totals row */}
                {["TOTAL", ytdPnL.revenue, Math.abs(ytdPnL.totals.COGS), ytdPnL.grossProfit, ytdPnL.expenses, ytdPnL.netProfit].map((v, i) => (
                  <div key={`tot-${i}`} style={{ fontSize: 13, fontWeight: 700, color: i === 0 ? "#f1f5f9" : (typeof v === "number" && v < 0 ? "#f87171" : "#22c55e"), textAlign: i > 0 ? "right" : "left", fontVariantNumeric: "tabular-nums", paddingTop: 12, borderTop: "1px solid #1e2535", marginTop: 4 }}>
                    {i === 0 ? v : fmt(v)}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── TRANSACTIONS ── */}
        {view === "transactions" && (
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search transactions…"
                style={{ flex: 1, background: "#161b27", border: "1px solid #1e2535", borderRadius: 8, padding: "8px 14px", color: "#e2e8f0", fontSize: 13, outline: "none" }} />
              <div style={{ fontSize: 12, color: "#64748b" }}>{filteredTx.length} transactions</div>
            </div>

            <div style={{ background: "#161b27", border: "1px solid #1e2535", borderRadius: 12, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "90px 2fr 130px 140px 110px 32px", gap: 8, padding: "10px 16px", background: "#0f1117", fontSize: 11, color: "#475569", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                <span>Trans. Date</span><span>Description</span><span>Category</span><span>Subcategory</span><span style={{ textAlign: "right" }}>Amount</span><span />
              </div>
              {filteredTx.map((tx, i) => (
                <div key={tx.id}>
                  {editingTx === tx.id ? (
                    <EditRow tx={tx} onSave={ch => updateTx(tx.id, ch)} onCancel={() => setEditingTx(null)} />
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "90px 2fr 130px 140px 110px 32px", gap: 8, padding: "10px 16px", borderTop: i > 0 ? "1px solid #1e2535" : "none", alignItems: "start", transition: "background 0.1s" }}
                      onMouseEnter={e => e.currentTarget.style.background = "#1a2030"}
                      onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                      <span style={{ fontSize: 12, color: "#64748b", fontVariantNumeric: "tabular-nums", paddingTop: 2 }}>{tx.transDate}</span>
                      <span style={{ fontSize: 12, color: "#cbd5e1", lineHeight: 1.5, wordBreak: "break-word" }}>{tx.description}</span>
                      <span style={{ paddingTop: 1 }}>
                        <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, background: `${CATEGORIES[tx.category]?.color}22`, color: CATEGORIES[tx.category]?.color, fontWeight: 500, whiteSpace: "nowrap" }}>
                          {CATEGORIES[tx.category]?.label || tx.category}
                        </span>
                      </span>
                      <span style={{ fontSize: 11, color: "#64748b", paddingTop: 3, lineHeight: 1.4 }}>{tx.subcategory}</span>
                      <span style={{ fontSize: 13, fontWeight: 600, textAlign: "right", color: tx.amount >= 0 ? "#22c55e" : "#f87171", fontVariantNumeric: "tabular-nums", paddingTop: 2, whiteSpace: "nowrap" }}>{fmt(tx.amount)}</span>
                      <button onClick={() => setEditingTx(tx.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#475569", fontSize: 14, padding: 0, display: "flex", alignItems: "flex-start", paddingTop: 2 }}>✎</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── UPLOAD ── */}
        {view === "upload" && (
          <div style={{ maxWidth: 560, margin: "0 auto" }}>
            <div onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={handleDrop}
              style={{ background: dragging ? "rgba(34,197,94,0.06)" : "#161b27", border: `2px dashed ${dragging ? "#22c55e" : "#1e2535"}`, borderRadius: 16, padding: 48, textAlign: "center", transition: "all 0.15s" }}>
              <div style={{ fontSize: 44, marginBottom: 16 }}>
                {uploadStatus === "reading" || uploadStatus === "loading" ? "⏳" : uploadStatus === "done" ? "✅" : "📑"}
              </div>
              <div style={{ fontSize: 16, fontWeight: 600, color: "#f1f5f9", marginBottom: 8 }}>
                {uploadStatus === "reading" ? "Reading PDF…" : uploadStatus === "loading" ? "Loading PDF engine…" : uploadStatus === "done" ? "Statement imported!" : "Import Capitec Statement"}
              </div>
              <div style={{ fontSize: 13, color: "#64748b", marginBottom: 24 }}>
                {uploadStatus === "error" ? "No transactions found. Make sure this is a Capitec Business Account PDF."
                  : uploadStatus === "done" ? "Transactions auto-categorised — your learned rules were applied."
                  : learnedRules.length > 0 ? `Drop your PDF here. ${learnedRules.length} learned rule${learnedRules.length > 1 ? "s" : ""} will be applied automatically.`
                  : "Drop your PDF here, or click to browse. Transactions are auto-categorised and editable."}
              </div>
              <input ref={fileRef} type="file" accept="application/pdf,.pdf" style={{ display: "none" }} onChange={handleFileInputChange} />
              {(!uploadStatus || uploadStatus === "error") && (
                <button onClick={() => fileRef.current.click()} style={{ background: "#22c55e", color: "#0f1117", border: "none", borderRadius: 8, padding: "10px 28px", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
                  Choose PDF
                </button>
              )}
              {(uploadStatus === "reading" || uploadStatus === "loading") && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "#38bdf8", fontSize: 13 }}>
                  <div style={{ width: 16, height: 16, border: "2px solid #1e2535", borderTop: "2px solid #38bdf8", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                  {uploadStatus === "loading" ? "Loading PDF.js engine…" : "Extracting transactions…"}
                </div>
              )}
              {uploadStatus === "error" && (
                <button onClick={() => setUploadStatus(null)} style={{ marginTop: 8, background: "transparent", border: "1px solid #1e2535", borderRadius: 8, padding: "8px 20px", fontSize: 13, color: "#94a3b8", cursor: "pointer" }}>Try again</button>
              )}
            </div>

            <div style={{ ...card, marginTop: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8", marginBottom: 12 }}>What to upload</div>
              {[
                "Download your statement PDF from the Capitec Business Banking app or online portal",
                "No conversion needed — upload the PDF directly",
                "Each statement becomes a new month in the tracker",
                "Your learned categorisation rules are applied automatically on import",
              ].map((tip, i) => (
                <div key={i} style={{ display: "flex", gap: 12, marginBottom: 10, alignItems: "flex-start" }}>
                  <span style={{ width: 20, height: 20, borderRadius: "50%", background: "#1e2535", color: "#22c55e", fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>{i + 1}</span>
                  <span style={{ fontSize: 13, color: "#64748b", lineHeight: 1.5 }}>{tip}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Inline edit row ──────────────────────────────────────────────────────────
function EditRow({ tx, onSave, onCancel }) {
  const [cat, setCat] = useState(tx.category);
  const [sub, setSub] = useState(tx.subcategory);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "90px 2fr 130px 140px 110px 32px", gap: 8, padding: "8px 16px", background: "#1a2030", borderTop: "1px solid #1e2535", alignItems: "center" }}>
      <span style={{ fontSize: 12, color: "#64748b" }}>{tx.postDate}</span>
      <span style={{ fontSize: 12, color: "#cbd5e1", lineHeight: 1.5, wordBreak: "break-word" }}>{tx.description}</span>
      <select value={cat} onChange={e => { setCat(e.target.value); setSub(CATEGORIES[e.target.value].subcategories[0]); }}
        style={{ background: "#0f1117", border: "1px solid #22c55e", borderRadius: 6, color: "#e2e8f0", fontSize: 12, padding: "4px 8px" }}>
        {Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
      </select>
      <select value={sub} onChange={e => setSub(e.target.value)}
        style={{ background: "#0f1117", border: "1px solid #1e2535", borderRadius: 6, color: "#e2e8f0", fontSize: 12, padding: "4px 8px" }}>
        {(CATEGORIES[cat]?.subcategories || []).map(s => <option key={s} value={s}>{s}</option>)}
      </select>
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button onClick={() => onSave({ category: cat, subcategory: sub })} style={{ background: "#22c55e", border: "none", borderRadius: 5, color: "#0f1117", fontSize: 11, fontWeight: 700, padding: "4px 8px", cursor: "pointer" }}>Save</button>
        <button onClick={onCancel} style={{ background: "#1e2535", border: "none", borderRadius: 5, color: "#94a3b8", fontSize: 11, padding: "4px 8px", cursor: "pointer" }}>✕</button>
      </div>
      <span />
    </div>
  );
}
