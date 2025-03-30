from odoo import fields, models


class ResUsers(models.Model):
    _inherit = "res.users"

    list_order_ids = fields.One2many(
        comodel_name="list.order",
        inverse_name="user_id",
        string="List Orders",
    )
    list_order_line_ids = fields.One2many(
        comodel_name="list.order.line",
        inverse_name="user_id",
        string="List Order Lines",
    )
