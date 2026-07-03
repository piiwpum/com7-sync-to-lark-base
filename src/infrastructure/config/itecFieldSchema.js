// (name, sqlType) in schema order (ITEC SELL ITEM SUMMARY). sqlType -> Lark field def.
const RAW = [
  ['CrTime', 'datetime'], ['SellID', 'int'], ['SellBranch', 'int'], ['Product', 'varchar'],
  ['MIN PRICE', 'money'], ['SRP', 'money'], ['NUMBER', 'int'], ['PBV', 'numeric'], ['PAV', 'numeric'],
  ['TOTAL PBV', 'money'], ['VAT', 'float'], ['TOTAL PAV', 'numeric'], ['COGS / UNIT', 'money'],
  ['GP / UNIT', 'numeric'], ['COGS', 'money'], ['GP', 'money'], ['GP %', 'float'], ['VAT %', 'money'],
  ['VATValue', 'money'], ['TotalPrice', 'money'], ['VAT ALLOCATE', 'float'], ['Product Name', 'varchar'],
  ['CategoryID', 'int'], ['CategoryName', 'varchar'], ['SubCat', 'varchar'], ['Brand', 'varchar'],
  ['Model', 'varchar'], ['ProductType', 'varchar'], ['Customer Code', 'varchar'], ['Customer Name', 'varchar'],
  ['Customer Type', 'varchar'], ['CustomerTypeID', 'int'], ['Branch Name', 'varchar'], ['STATUS', 'int'],
  ['UTime', 'datetime'], ['SerialShouldSalesFirst', 'varchar'], ['is_return', 'int'], ['is_tradein', 'int'],
  ['mem_code', 'varchar'], ['Comment', 'varchar'], ['is_unbrick', 'int'],
];

const PRECISION = { int: 0, money: 2, numeric: 4, float: 2 };

function toField(name, sqlType) {
  if (sqlType === 'datetime') return { type: 'datetime', name, style: { format: 'yyyy-MM-dd HH:mm' } };
  if (sqlType === 'varchar') return { type: 'text', name };
  return { type: 'number', name, style: { type: 'plain', precision: PRECISION[sqlType] } };
}

export const ITEC_FIELD_SCHEMA = RAW.map(([name, t]) => toField(name, t));
export const ITEC_FIELD_NAMES = ITEC_FIELD_SCHEMA.map((f) => f.name);
