import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { Category } from './entities/category.entity';
import { getCategoryDisplayMeta } from '../common/constants/category.constants.js';
import {
  formatExamRuleResponse,
  resolveGeorgianExamRule,
} from '../common/utils/georgian-exam-rules.util.js';

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(Category)
    private readonly categoryRepo: Repository<Category>,
  ) {}

  create(_createCategoryDto: CreateCategoryDto) {
    return 'This action adds a new category';
  }

  private withExamRules(
    category: Pick<
      Category,
      'id' | 'name' | 'iconKey' | 'questionsCount' | 'subjectCount'
    >,
  ) {
    const display = getCategoryDisplayMeta(category.id);
    const rule = resolveGeorgianExamRule({ categories: [category.id] });
    return {
      ...category,
      name: display?.name ?? category.name,
      iconKey: display?.iconKey ?? category.iconKey,
      ...formatExamRuleResponse(category.id, rule),
    };
  }

  async findAll() {
    const rows = await this.categoryRepo.find({
      order: { id: 'ASC' },
      select: ['id', 'name', 'iconKey', 'questionsCount', 'subjectCount'],
    });
    return rows.map((row) => this.withExamRules(row));
  }

  async findOne(id: number) {
    const category = await this.categoryRepo.findOne({ where: { id } });
    if (!category) {
      throw new NotFoundException(`Category ${id} not found`);
    }

    const subjects = [...(category.subjects ?? [])].sort((a, b) => a.id - b.id);
    return {
      ...this.withExamRules(category),
      subjects,
    };
  }

  update(id: number, _updateCategoryDto: UpdateCategoryDto) {
    return `This action updates a #${id} category`;
  }

  remove(id: number) {
    return `This action removes a #${id} category`;
  }
}
