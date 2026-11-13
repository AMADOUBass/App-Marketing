import { Module } from '@nestjs/common';
import { TenancyController } from './tenancy.controller.js';

@Module({ controllers: [TenancyController] })
export class TenancyModule {}
