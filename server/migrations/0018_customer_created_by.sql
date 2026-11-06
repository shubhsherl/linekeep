-- Which employee added a customer from the app (NULL for customers created by an administrator or imported).
-- Additive only; the assignment table still decides who may see the customer.
ALTER TABLE customers ADD COLUMN created_by_employee_id TEXT REFERENCES employees(id);
